import { styleTerminalText, supportsTerminalColor, writeOutput } from "../terminal/output";
import { caseRunnerProvider, createCaseRunner } from "../case/runners";
import { bindService, loadCaseCatalog, type PluginDefinition, type ServiceCaseObservation, type ServiceCaseRunner } from "@compforge/doctor-plugin";
import { graphFromServices, type Operation } from "@compforge/harness-common";
import { Engine, writeRunData, type CaseMixEntry, type CaseSet, type Outcome, type Run, type Experiment } from "@compforge/perf-harness";
import { observePerf, preparePerfMetrics } from "./observations";
import { PerfProgress, formatPerfSummary } from "./progress";
import { discoverTenantDirectory } from "../plugin/tenant-directory";
import { isInteractive } from "../terminal/policy";
import { resolveCaseRequestIdentity } from "../case";
import { selectDoctorCases } from "../case/catalog";
import { CommandInputError, CommandStatus, type CommandContext, type CommandResult } from "../command";
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
          input: { id: perfCase.id, input: perfCase.input, facets: perfCase.facets },
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
      const hint = styleTerminalText("hold 建议覆盖 4～5 个 scrape（指标采样）周期", "info", supportsTerminalColor(process.stderr));
      writeOutput(`[perf] ${hint}：间隔 15s 时约 60～75s，间隔 60s 时约 240～300s。\n`
        + "[perf] 窗口内若只有 1 个采样点，无法计算增量、窗口 p95 或错误率属于预期情况；请按实际采样间隔选择时长。\n", process.stderr);
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

/** Case selects the observation entry. Only positive injection acquires business access. */
export async function runPerf(opts: PerfCliOpts, plugin: PluginDefinition, context: CommandContext): Promise<CommandResult<PerfResult>> {
  const config = resolvePerfConfig(opts);
  const sources = plugin.services.caseSources().filter(item => item.source.operation);
  if (!sources.length) throw new CommandInputError("没有绑定 Operation 的 Case 来源，无法确定观测入口");
  const catalog = sources.flatMap(({service, source}) => loadCaseCatalog(source).map(caseSet => ({
    source: "plugin" as const, service: service.name, sourceId: source.id, caseSet,
  })));
  const selection = await selectDoctorCases({catalog, command: "perf", caseSetId: opts.caseset, caseIds: opts.cases, supports: () => true});
  if (!selection || !await selectParameters(opts, config)) return {status: CommandStatus.Cancelled, artifacts: []};
  const loads = perfLoadPlans(config);
  const selected = sources.find(item => item.service.name === selection.source.service && item.source.id === selection.source.sourceId)!;
  const operation = plugin.services.operation(selected.source.operation!).operation;
  const declarations = plugin.services.operations().map(item => item.operation);
  let service = bindService(selected.service, {name: context.profile.name});
  let managed: Awaited<ReturnType<typeof openPluginContext>> | undefined;
  let adapter: Pick<Experiment, "runner" | "judge"> = {};
  if (config.qps > 0) {
    const provider = caseRunnerProvider(plugin.services, selected.service.name, selected.source.id);
    if (selection.cases.some(item => !provider.factory.supports(item))) throw new CommandInputError("所选 Case 不受其 runner 支持");
    const approved = await resolveApprovalGate(opts)({id:"perf-load", risk:"disrupt", title:"执行 Perf 加压",
      purpose:"观察系统在受控注入流量下的表现", target:`${context.profile.name}/${selected.service.name}`,
      impact:[`注入 QPS ${config.qps}，最大在途 ${config.maxInflight}，hold ${config.holdSeconds}s，warmup ${config.rampSeconds}s`,
        `Case: ${selection.cases.map(item => item.id).join(", ")}；多 Case 等权随机抽取`,
        "真实业务请求可能写入数据、产生模型费用并增加下游压力；不设置请求总数上限",
        `错误率 ${(config.abortErrorRate*100).toFixed(0)}%（至少 ${config.breakerMinN} 个样本）熔断；Ctrl+C 结束观测并生成报告`]});
    if (!approved.approved) return {status:CommandStatus.Cancelled, artifacts:[]};
    const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
    if (!kube) return {status:CommandStatus.Cancelled, artifacts:[]};
    const executor = createKubernetesExecutor(kube);
    const environment = await resolveKubernetesEnvironment(executor);
    service = bindService(selected.service, environment);
    const configured = provider.factory.requestIdentity?.configured(context.profile.pluginConfig);
    const requestIdentity = configured ? await resolveCaseRequestIdentity({configured,
      directory: discoverTenantDirectory(plugin.services, (owner, extension) => openPluginContext(executor, kube.kubernetes, {
        config:context.profile.pluginConfig, service:owner, endpoint:extension.endpoint, capability:extension,
        clients:context.clients, signal:context.signal, environment,
      })), commandLabel:"Perf", logPrefix:"perf"}) : undefined;
    if (configured && !requestIdentity) return {status:CommandStatus.Cancelled, artifacts:[]};
    // Lazy access: Engine owns the setup boundary and QPS=0 never enters this factory.
    adapter = perfAdapterFromCaseFactory(`${selected.service.name}/${selected.source.id}`, async () => {
      managed = await openPluginContext(executor, kube.kubernetes, {config:context.profile.pluginConfig,
        service:selected.service, endpoint:provider.factory.endpoint, capability:provider.factory,
        clients:context.clients, signal:context.signal, environment});
      return createCaseRunner(provider.factory, managed, {caseSetId:selection.source.caseSet.caseset,
        timeoutMs:config.requestTimeoutMs, requestIdentity});
    }, operation);
  }
  const preparedMetrics = await preparePerfMetrics(declarations, context, opts.prometheus);
  writeOutput(formatPerfCaseMix(selection.source.caseSet, selection.cases.map(item => ({id:item.id, weight:1}))), process.stderr);
  const artifact = createPerfArtifact(config), outputDir = artifact.path;
  context.artifacts.add({command:"perf", path:outputDir});
  const metadata = {caseSource:{service:selected.service.name, source:selected.source.id}, operation:operation.id(),
    caseFacets:selection.source.caseSet.facets ?? {}, caseIds:selection.cases.map(item => item.id)};
  writePerfMetadata(outputDir, metadata);
  const graph = graphFromServices(plugin.services.services.map(item => bindService(item, service.environment)), {
    source:`declared:plugin/${plugin.id}`, version:plugin.version});
  const progress = new PerfProgress();
  let run: Run | undefined, failure: unknown;
  try {
    try {
      run = await new Engine({name:`doctor-${selected.service.name}-perf`, service, graph:graph.toJSON(),
        entryIds:[operation.id()], ...progress.observe(adapter), caseSet:selection.source.caseSet,
        caseMix:selection.cases.map(item => ({id:item.id, weight:1})), loads, signal:context.signal, stopSignal:progress.stop.signal,
        onArmStart: () => {
          writeOutput(`[perf] 开始观测：注入 QPS=${config.qps}，${config.qps ? `max_inflight=${config.maxInflight}，` : ""}hold=${config.holdSeconds}s\n`, process.stderr);
          writeOutput("[perf] Ctrl+C 结束本轮观测并生成报告。\n", process.stderr);
          progress.start(context);
        },
      }).run();
    } catch (error) { failure = error; }
    finally {
      progress.requestsFinished();
      try { if (run) writeRunData(run, outputDir); }
      finally { try { await managed?.dispose(); } catch (error) { failure ??= error; } }
    }
    if (!run) {
      if (context.signal.aborted) return {status:CommandStatus.Cancelled, artifacts:context.artifacts.list()};
      throw failure ?? new Error("Perf 未形成运行记录");
    }
    const metrics = await observePerf(run, outputDir, declarations, context, opts.prometheus, preparedMetrics);
    writePerfMetadata(outputDir, metadata, metrics);
    writeOutput(formatPerfSummary(run, metrics.metricIssues), process.stderr);
    return {status:context.signal.aborted ? CommandStatus.Cancelled : failure || run.status !== "completed" || !metrics.metricsComplete ? CommandStatus.Partial : CommandStatus.Ok,
      reason:failure ? diagnosticMessage(failure) : undefined,
      output:{run, outputDir, ...metrics, caseFacets:selection.source.caseSet.facets}, artifacts:context.artifacts.list()};
  } finally { progress.dispose(); }
}
