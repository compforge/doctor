import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeOutput } from "../terminal/output";
import { caseRunnerProvider, createCaseRunner, runnerCaseCatalog } from "../case/runners";
import { selectPerfProvider, loadPerfScenarios } from "./extensions";
import { bindService } from "@compforge/doctor-plugin";
import { graphFromServices, type Operation } from "@compforge/harness-common";
import { observePerf } from "./observations";
import { discoverTenantDirectory } from "../plugin/tenant-directory";
import { isInteractive } from "../terminal/policy";
import type {
  PluginDefinition,
  ServiceCaseObservation,
  ServiceCaseRunner,
  ServiceRequestIdentity,
} from "@compforge/doctor-plugin";
import {
  Engine,
  writeRunData,
  type CaseMixEntry,
  type CaseSet,
  type Outcome,
  type Run,
  type Experiment,
} from "@compforge/perf-harness";
import { resolveCaseRequestIdentity } from "../case";
import { doctorCaseCatalog, selectDoctorCases } from "../case/catalog";
import { CommandStatus, type CommandContext, type CommandResult } from "../command";
import { approvalDeniedReason } from "../command/approval";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../command/kubernetes-target";
import { openPluginContext, createHostPluginContext } from "../plugin/context";
import { resolveApprovalGate } from "../terminal/approval";

import { useLogger } from "../terminal/log";
import { promptListedChoice } from "../terminal/selection";
import {
  PERF_MAX_CONCURRENCY_OPTIONS,
  perfLevelsThrough,
  resolvePerfConfig,
  perfLoadPlans,
} from "./config";
import type { PerfCliOpts, PerfResult } from "./model";
import { createPerfArtifact } from "./output";

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
): Pick<Experiment, "runner" | "judge"> {
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

/** Root cancellation remains visible even when an embedding distribution suppresses info logs. */
export async function runPerf(
  opts: PerfCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<CommandResult<PerfResult>> {
  const cancelled = () => writeOutput("[perf] 已取消：正在通知请求与采集组件停止，等待清理并保存已有证据…\n", process.stderr);
  commandContext.signal.addEventListener("abort", cancelled, { once: true });
  try {
    commandContext.signal.throwIfAborted();
    return await executePerf(opts, plugin, commandContext);
  } finally {
    commandContext.signal.removeEventListener("abort", cancelled);
  }
}

async function executePerf(
  opts: PerfCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<CommandResult<PerfResult>> {
  const config = resolvePerfConfig(opts);
  const selected = selectPerfProvider(plugin.services, config.service);
  const provider = selected.service;
  const kube = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!kube) return { status: CommandStatus.Cancelled, artifacts: [] };
  const executor = createKubernetesExecutor(kube);
  const scenarios = await loadPerfScenarios(selected, () => {
    const options = {
      service: provider, capability: selected.extension,
      config: commandContext.profile.pluginConfig, clients: commandContext.clients, signal: commandContext.signal,
    };
    return selected.extension.access.kubernetes?.length
      ? openPluginContext(executor, {
        namespace: kube.kubernetes.namespace, kubeconfig: kube.kubernetes.kubeconfig, context: kube.kubernetes.context,
      }, options)
      : createHostPluginContext({ ...options, namespace: kube.kubernetes.namespace });
  });
  const scenario = config.scenario ?? scenarios[0]?.id;
  const declaredScenario = scenarios.find((item) => item.id === scenario);
  if (!declaredScenario) throw new Error(`Service '${provider.name}' 未声明 perf scenario '${scenario}'`);
  const runnerProvider = caseRunnerProvider(plugin.services, declaredScenario.cases.service, declaredScenario.cases.source);
  const catalog = doctorCaseCatalog(plugin, opts.caseFile, undefined, runnerProvider.service.name);
  const caseSelection = await selectDoctorCases({
    catalog: runnerCaseCatalog(catalog, runnerProvider),
    supports: runnerProvider.factory.supports,
    command: "perf",
    caseSetId: opts.caseset,
    caseIds: opts.cases,
  });
  if (!caseSelection) return { status: CommandStatus.Cancelled, artifacts: [] };
  const caseSet = caseSelection.source.caseSet;
  const caseMix = caseSelection.cases.map((item) => ({ id: item.id, weight: 1 }));

  if (!opts.levels?.trim() && isInteractive()) {
    writeOutput(`可选最高并发：${PERF_MAX_CONCURRENCY_OPTIONS.join(" / ")}（默认 20）` + "\n");
    const maxConcurrency = await promptListedChoice({
      question: "请选择最高并发（输入并发值，直接回车使用 20，q 取消）：",
      match: (answer) => {
        const value = Number(answer.trim());
        return PERF_MAX_CONCURRENCY_OPTIONS.includes(
          value as (typeof PERF_MAX_CONCURRENCY_OPTIONS)[number],
        ) ? value : undefined;
      },
      invalidMessage: `最高并发只支持 ${PERF_MAX_CONCURRENCY_OPTIONS.join("、")}`,
      emptyValue: 20,
    });
    if (maxConcurrency === undefined) return { status: CommandStatus.Cancelled, artifacts: [] };
    config.levels = perfLevelsThrough(maxConcurrency);
  }

  const loads = perfLoadPlans(config);
  const operationId = runnerProvider.source.operation;
  if (!operationId) throw new Error("Perf Case source must declare its Operation");
  const operation = plugin.services.operation(operationId).operation;
  // Bind the catalog to the same resolved environment as the request runner below.
  const declarations = plugin.services.operations().map(item => item.operation);

  let requestIdentity: ServiceRequestIdentity | undefined;
  const identityRequirement = runnerProvider.factory.requestIdentity;
  if (identityRequirement) {
    const configured = identityRequirement.configured(commandContext.profile.pluginConfig);
    const tenantId = configured.tenantId?.trim();
    const userId = configured.userId?.trim();
    if (tenantId && userId) {
      requestIdentity = { tenantId, userId };
    } else {
      if (!(isInteractive())) {
        throw new Error("非交互环境的 Perf Case 必须由 Plugin profile 配置提供 tenant_id 和 user_id");
      }
      const directory = discoverTenantDirectory(plugin.services, (service, extension) => openPluginContext(executor, {
        namespace: kube.kubernetes.namespace,
        kubeconfig: kube.kubernetes.kubeconfig,
        context: kube.kubernetes.context,
      }, {
        config: commandContext.profile.pluginConfig,
        service,
        endpoint: extension.endpoint,
        capability: extension,
      }));
      requestIdentity = await resolveCaseRequestIdentity({
        configured: { tenantId, userId }, directory, commandLabel: "Perf", logPrefix: "perf",
      });
      if (!requestIdentity) {
        useLogger("perf").warn("已取消身份选择");
        return { status: CommandStatus.Cancelled, artifacts: [] };
      }
    }
    useLogger("perf").info(`identity: tenant=${requestIdentity.tenantId} user=${requestIdentity.userId}`);
  }

  const decision = await resolveApprovalGate(opts)({
    id: "perf-load",
    risk: "disrupt",
    title: `执行 ${declaredScenario.title} 压测`,
    purpose: declaredScenario.description,
    target: `${kube.profileName}/${kube.kubernetes.namespace}/${runnerProvider.service.name}`
      + ` · concurrency ${config.levels.join(" → ")}`,
    impact: [
      `场景：${provider.name}/${declaredScenario.id}；Case 来源：${runnerProvider.service.name}/${runnerProvider.source.id}`,
      `Case: ${caseSet.caseset}/${caseSelection.cases.map((item) => item.id).join(", ")}；多 Case 等权随机抽取`,
      `每档 ramp ${config.rampSeconds}s + hold ${config.holdSeconds}s；共 ${config.levels.length * (config.rampSeconds + config.holdSeconds)}s 发压时间`,
      "按并发与时长持续发送请求，不设置请求总数上限；可随时 Ctrl+C 取消",
      "请求会写入业务数据库、日志和 trace，并可能产生模型调用费用",
      `错误率达到 ${(config.abortErrorRate * 100).toFixed(0)}%（至少 ${config.breakerMinN} 个样本）时停止当前档`,
      "压测可能放大目标 Service 及其下游的延迟和资源压力",
    ],
  });
  if (!decision.approved) {
    useLogger("perf").warn(`${approvalDeniedReason(decision.source)}`);
    return { status: CommandStatus.Cancelled, artifacts: [] };
  }

  const artifact = createPerfArtifact(config);
  const outputDir = artifact.path;
  commandContext.artifacts.add({ command: "perf", path: outputDir });
  const metadata = { schema: 1, caseSource: declaredScenario.cases,
    operation: operation.id(), caseFacets: caseSet.facets ?? {}, caseIds: caseSelection.cases.map(item => item.id) };
  writeFileSync(join(outputDir, "perf.json"), JSON.stringify(metadata, null, 2));

  const managed = await openPluginContext(executor, {
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
  }, {
    config: commandContext.profile.pluginConfig,
    service: runnerProvider.service,
    endpoint: runnerProvider.factory.endpoint,
    capability: runnerProvider.factory,
    signal: commandContext.signal,
    clients: commandContext.clients,
  });

  let run: Run | undefined;
  let loadError: unknown;
  try {
  const graph = graphFromServices(plugin.services.services.map(service => bindService(service, managed.target.service.environment)), {
    source: `declared:plugin/${plugin.id}`, version: plugin.version,
  });
    writeOutput(`[perf] 开始并发 ${config.levels.join(" → ")}\n`, process.stderr);
    run = await new Engine({
      name: `doctor-${provider.name}-${declaredScenario.id}`,
      service: managed.target.service,
      graph: graph.toJSON(),
      ...perfAdapterFromCaseFactory(`${runnerProvider.service.name}/${runnerProvider.source.id}`, () => createCaseRunner(runnerProvider.factory, managed, {
        caseSetId: caseSet.caseset, timeoutMs: config.requestTimeoutMs, requestIdentity,
      }), operation),
      caseSet, caseMix, loads, signal: commandContext.signal,
      onArmStart: context => { writeOutput(`[perf] 开始 ${context.arm.id}\n${formatPerfCaseMix(caseSet, caseMix)}`, process.stderr); },
    }).run();
  } catch (error) {
    loadError = error;
  } finally {
    // Persist request evidence even if resource disposal or later observation fails.
    try { if (run) writeRunData(run, outputDir); }
    finally { try { await managed.dispose(); } catch (error) { loadError ??= error; } }
  }
  if (!run) {
    if (commandContext.signal.aborted) return { status: CommandStatus.Cancelled, artifacts: commandContext.artifacts.list() };
    throw loadError ?? new Error("Perf Harness 未形成 Run");
  }
  const metrics = await observePerf(run, outputDir, declarations, commandContext, kube.kubernetes.namespace, opts.prometheus);
  writeFileSync(join(outputDir, "perf.json"), JSON.stringify({ ...metadata, ...metrics }, null, 2));
  return { status: commandContext.signal.aborted ? CommandStatus.Cancelled
    : loadError || run.status !== "completed" || !metrics.metricsComplete ? CommandStatus.Partial : CommandStatus.Ok,
    reason: loadError ? "请求资源清理未完成；已有结果已保存" : undefined,
    output: { run, outputDir, ...metrics, caseFacets: caseSet.facets },
    artifacts: commandContext.artifacts.list() };
}
