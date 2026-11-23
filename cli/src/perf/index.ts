import { resolveCollectNamespace } from "../infra/k8s/context";
import { useLogger } from "../terminal/log";
import { writeOutput } from "../terminal/output";
import { caseRunnerProvider, createCaseRunner } from "../case/runners";
import { bindService, type PluginDefinition, type ServiceCaseObservation, type ServiceCaseRunner } from "@compforge/doctor-plugin";
import { graphFromServices, type Operation } from "@compforge/harness-common";
import { Engine, writeRunData, type CaseMixEntry, type CaseSet, type Outcome, type Run, type Experiment } from "@compforge/perf-harness";
import { observePerf, preparePerfMetrics } from "./observations";
import { PerfProgress, formatPerfSummary } from "./progress";
import { discoverTenantDirectory } from "../plugin/tenant-directory";
import { isInteractive } from "../terminal/policy";
import type { Case } from "@compforge/spec-case/model";
import { prepareCaseInput, prepareRunnerCommand, runnerIdentity } from "../case";
import { loadCaseDataset } from "./case-dataset";
import { perfCaseMix, routePerfCases, selectPerfTarget } from "./selection";
import type { DoctorCaseSet } from "../case/catalog";
import { CommandStatus, type CommandContext, type CommandResult } from "../command";
import { diagnosticMessage } from "../command/diagnostic";
import { createKubernetesExecutor, resolveKubernetesCommandConfig } from "../command/kubernetes-target";
import { resolveKubernetesEnvironment } from "../infra/k8s/environment";
import { openPluginContext } from "../plugin/context";
import { resolveApprovalGate } from "../terminal/approval";
import { promptListedChoice } from "../terminal/selection";
import { resolvePerfConfig, perfLoadPlans } from "./config";
import type { PerfCliOpts, PerfResult, PerfConfig } from "./model";
import { createPerfArtifact, writePerfMetadata } from "./output";

export * from "./config";
export * from "./model";
export * from "./output";
export * from "./report";

export function formatPerfCaseMix(
  caseSet: CaseSet,
  caseMix: readonly CaseMixEntry[],
): string {
  const cases = new Map(caseSet.cases.map((item) => [item.id, item]));
  return caseMix.map(({ id, weight = 1 }) => {
    const selectedCase = cases.get(id);
    if (!selectedCase) throw new Error(`CaseSet '${caseSet.caseset}' 不包含 Case '${id}'`);
    const facets = Object.entries(selectedCase.facets ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    return `[perf]   case=${selectedCase.id} weight=${weight}${facets ? ` facets=${facets}` : ""}\n`;
  }).join("");
}

function toObservation(outcome: Outcome): ServiceCaseObservation {
  return {
    status: outcome.status,
    durationMs: outcome.duration_ms,
    events: outcome.events,
    nbytes: outcome.nbytes,
    metrics: outcome.metrics,
    meta: outcome.meta,
    errorKind: typeof outcome.meta?.error_kind === "string" ? outcome.meta.error_kind : undefined,
  };
}

/**
 * @spec The Harness owns runner resources from setup through cleanup, including cancelled setup.
 * @why Raw protocol observations survive independently of the request verdict in schema 12.
 */
export function perfAdapterFromCaseFactory(
  name: string, create: () => Promise<ServiceCaseRunner>, operation?: Operation,
): Required<Pick<Experiment, "runner" | "judge">> {
  let runner: ServiceCaseRunner | undefined;
  return {
    runner: {
      name,
      operation: operation ? () => operation : undefined,
      setup: async ({ run_id, signal }) => {
        runner ??= await create();
        signal.throwIfAborted();
        await runner.setup?.({ runId: run_id, signal });
      },
      fire: async ({ case: perfCase, run_id, signal }) => {
        const observation = await runner!.run({
          input: perfCase,
          runId: run_id, signal,
        });
        return {
          status: observation.status,
          duration_ms: observation.durationMs,
          events: observation.events,
          nbytes: observation.nbytes,
          metrics: observation.metrics ? { ...observation.metrics } : undefined,
          meta: { ...observation.meta, ...(observation.errorKind ? { error_kind: observation.errorKind } : {}) },
        };
      },
      deactivate: async ({ run_id, signal }) => {
        await runner?.deactivate?.({ runId: run_id, signal });
      },
      cleanup: async ({ run_id, signal }) => {
        await runner?.cleanup?.({ runId: run_id, signal });
      },
    },
    judge: outcome => {
      if (outcome.meta?.exc) return { code: "exception" };
      const verdict = runner!.classify(toObservation(outcome));
      if (verdict.ok) return { code: "success" };
      const code = verdict.errorKind?.trim();
      return { code: code && code !== "success" ? code : "failure" };
    },
  };
}

async function selectParameters(opts: PerfCliOpts, config: PerfConfig): Promise<boolean> {
  if (!isInteractive()) return true;
  for (const [option, key, title, integer, positive] of [
    ["qps", "qps", "注入 QPS（0 只观测自然流量）", false, false],
    ["maxInflight", "maxInflight", "最大在途请求数", true, true],
    ["hold", "holdSeconds", "hold 观测秒数", false, true],
  ] as const) {
    if (option === "maxInflight" && config.qps > 0) config.maxInflight = resolvePerfConfig({...opts, qps: String(config.qps)}).maxInflight;
    if (opts[option] !== undefined || (option === "maxInflight" && config.qps === 0)) continue;
    if (option === "hold") {
      useLogger("perf").warn("hold 建议覆盖 4～5 个 scrape（指标采样）周期：间隔 15s 时约 60～75s，间隔 60s 时约 240～300s。\n"
        + "窗口内若只有 1 个采样点，无法计算增量、窗口 p95 或错误率属于预期情况；请按实际采样间隔选择时长。");
    }
    const value = await promptListedChoice({question: `${title}（默认 ${config[key]}，q 取消）：`,
      emptyValue: config[key], invalidMessage: "请输入有效数值。",
      match: answer => {
        const n = Number(answer.trim());
        return Number.isFinite(n) && (positive ? n > 0 : n >= 0) && (!integer || Number.isInteger(n)) ? n : undefined;
      }});
    if (value === undefined) return false;
    config[key] = value;
  }
  return true;
}

/** Natural traffic observation requires only Operation declarations. */
export async function runPerf(opts: PerfCliOpts, plugin: PluginDefinition, context: CommandContext): Promise<CommandResult<PerfResult>> {
  const config = resolvePerfConfig(opts);
  if (!await selectParameters(opts, config)) return {status:CommandStatus.Cancelled, artifacts:[]};
  const target = await selectPerfTarget(plugin, opts, config.qps > 0);
  if (!target) return {status:CommandStatus.Cancelled, artifacts:[]};
  const {operation} = target;
  const mix = perfCaseMix(target.selected);
  const caseEntries = Object.fromEntries(mix.routes.map(({id, choice}) => [id,
    plugin.services.caseSource({service:target.service.name, source:choice.source.sourceId!}).source.operation ?? operation.id(),
  ]));
  const entryIds = [...new Set([operation.id(), ...Object.values(caseEntries)])];
  const loads = perfLoadPlans(config);
  const declarations = plugin.services.operations().map(item => item.operation);
  let service = bindService(target.service, {name:context.profile.name});
  const contexts: Awaited<ReturnType<typeof openPluginContext>>[] = [];
  let adapter: Pick<Experiment, "runner" | "judge"> = {};
  if (config.qps > 0) {
    const rows = opts.caseDataset === undefined ? [] : await loadCaseDataset(opts.caseDataset, target.selected.map(c => c.item));
    if (rows.length) useLogger("perf").info(`Case dataset：${rows.length} 行，每次请求随机选取一行`);
    const approved = await resolveApprovalGate(opts)({id:"perf-load", risk:"disrupt", title:"执行 Perf 加压",
      purpose:"观察系统在受控注入流量下的表现", target:`${context.profile.name}/${target.service.name}`,
      impact:[`注入 QPS ${config.qps}，最大在途 ${config.maxInflight}，hold ${config.holdSeconds}s，warmup ${config.rampSeconds}s`,
        `Case: ${Object.values(mix.caseRefs).join(", ")}；多 Case 等权随机抽取`,
        "真实业务请求可能写入数据、产生模型费用并增加下游压力；不设置请求总数上限",
        `错误率 ${(config.abortErrorRate*100).toFixed(0)}%（至少 ${config.breakerMinN} 个样本）熔断；Ctrl+C 结束观测并生成报告`]});
    if (!approved.approved) return {status:CommandStatus.Cancelled, artifacts:[]};
    const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
    if (!kube) return {status:CommandStatus.Cancelled, artifacts:[]};
    const executor = createKubernetesExecutor(kube);
    const environment = await resolveKubernetesEnvironment(executor);
    service = bindService(target.service, environment);
    const adapters = new Map<DoctorCaseSet, ReturnType<typeof perfAdapterFromCaseFactory>>();
    const inputs = new Map<Case, () => Case>();
    for (const source of mix.sources) {
      const provider = caseRunnerProvider(plugin.services, target.service.name, source.sourceId);
      const cases = mix.routes.filter(route => route.choice.source === source).map(route => route.choice.item);
      const directory = discoverTenantDirectory(plugin.services, (owner, extension) => openPluginContext(executor, kube.kubernetes, {
        config: context.profile.pluginConfig, service: owner, endpoint: extension.endpoint, capability: extension,
        clients: context.clients, signal: context.signal, environment,
      }), { commandContext: context });
      const command = await prepareRunnerCommand(provider.factory, cases, rows, context, directory, "Perf");
      if (!command) return {status:CommandStatus.Cancelled, artifacts:[]};
      for (const item of cases) {
        const render = await prepareCaseInput(item, rows, command);
        if (!render) return {status:CommandStatus.Cancelled, artifacts:[]};
        inputs.set(item, render);
      }
      // Lazy access: Engine owns the setup boundary and QPS=0 never enters this factory.
      const adapter = perfAdapterFromCaseFactory(`${target.service.name}/${source.sourceId}`, async () => {
        const managed = await openPluginContext(executor, kube.kubernetes, {command, config:context.profile.pluginConfig,
          service:target.service, endpoint:provider.factory.endpoint, capability:provider.factory,
          clients:context.clients, signal:context.signal, environment});
        contexts.push(managed);
        return createCaseRunner(provider.factory, managed, {caseSetId:source.caseSet.caseset,
          timeoutMs:config.requestTimeoutMs, requestIdentity:runnerIdentity(command)});
      }, provider.source.operation ? plugin.services.operation(provider.source.operation).operation : undefined);
      adapters.set(source, adapter);
    }
    adapter = routePerfCases(mix, adapters, inputs);
  }
  const preparedMetrics = await preparePerfMetrics(declarations, context, opts.prometheus,
    plugin.services.services, resolveCollectNamespace(opts, context.profile).namespace);
  if (mix.caseSet) writeOutput(formatPerfCaseMix(mix.caseSet, mix.caseMix), process.stderr);
  const artifact = createPerfArtifact(config), outputDir = artifact.path;
  context.artifacts.add({command:"perf", path:outputDir});
  const metadata = {service:target.service.name, caseRefs:mix.caseRefs, caseEntries, caseSource:mix.sources.length === 1 ? {service:target.service.name, source:mix.sources[0]!.sourceId!} : undefined, operation:operation.id(),
    caseFacets:mix.caseSet?.facets ?? {}, caseIds:mix.caseMix.map(item => item.id)};
  writePerfMetadata(outputDir, metadata);
  const graph = graphFromServices(plugin.services.services.map(item => bindService(item, service.environment)), {
    source:`declared:plugin/${plugin.id}`, version:plugin.version});
  const progress = new PerfProgress();
  let run: Run | undefined, failure: unknown;
  try {
    try {
      run = await new Engine({name:`doctor-${target.service.name}-perf`, service, graph:graph.toJSON(),
        entryIds, ...progress.observe(adapter), caseSet:mix.caseSet,
        caseMix:mix.caseMix, loads, signal:context.signal, stopSignal:progress.stop.signal,
        onArmStart: () => {
          writeOutput(`[perf] 开始观测：注入 QPS=${config.qps}，${config.qps ? `max_inflight=${config.maxInflight}，` : ""}hold=${config.holdSeconds}s\n`, process.stderr);
          writeOutput("[perf] Ctrl+C 结束本轮观测并生成报告。\n", process.stderr);
          progress.start(context);
        },
      }).run();
      run.case_entries = caseEntries;
      if (!config.qps) run.case_ids = [];
    } catch (error) { failure = error; }
    finally {
      progress.requestsFinished();
      try { if (run) writeRunData(run, outputDir); }
      finally { try { await Promise.all(contexts.map(c => c.dispose())); } catch (error) { failure ??= error; } }
    }
    if (!run) {
      if (context.signal.aborted) return {status:CommandStatus.Cancelled, artifacts:context.artifacts.list()};
      throw failure ?? new Error("Perf 未形成运行记录");
    }
    const metrics = await observePerf(run, outputDir, declarations, context, opts.prometheus, preparedMetrics);
    const caseCounts = Object.fromEntries(mix.caseMix.map(({id}) => [id, 0]));
    for (const arm of run.executions) {
      for (const request of arm.requests) if (request.dispatched_at !== undefined) {
        caseCounts[request.case_id] = (caseCounts[request.case_id] ?? 0) + 1;
      }
    }
    writePerfMetadata(outputDir, {...metadata, caseCounts}, metrics);
    writeOutput(formatPerfSummary(run, metrics.metricIssues), process.stderr);
    return {status:context.signal.aborted ? CommandStatus.Cancelled : failure || run.status !== "completed" || !metrics.metricsComplete ? CommandStatus.Partial : CommandStatus.Ok,
      reason:failure ? diagnosticMessage(failure) : undefined,
      output:{run, outputDir, ...metrics, caseFacets:mix.caseSet?.facets}, artifacts:context.artifacts.list()};
  } finally { progress.dispose(); }
}
