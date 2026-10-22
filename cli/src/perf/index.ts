import { writeOutput } from "../terminal/output";
import { caseRunnerProvider, createCaseRunner, runnerCaseCatalog } from "../case/runners";
import { selectPerfProvider, loadPerfScenarios } from "./extensions";
import { METRIC_CONFIGURATION_KIND } from "@compforge/doctor-plugin";
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
import { logCommand } from "../collect/log/command";
import { metricCommand } from "../collect/metric/command";
import { traceCommand } from "../collect/trace/command";
import { CommandStatus, aggregateCommandStatus, resolveKubernetesCommandContext, type CommandContext, type CommandResult } from "../command";
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
import type { PerfCliOpts, PerfEvidenceSample, PerfResult } from "./model";
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
 * @why Raw protocol observations survive independently of the request verdict in schema 6.
 */
export function perfAdapterFromCaseFactory(
  name: string, create: () => Promise<ServiceCaseRunner>,
): Pick<Experiment, "runner" | "judge"> {
  let runner: ServiceCaseRunner | undefined;
  return {
    runner: {
      name,
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
      if (outcome.meta?.exc) return { ok: false, error_kind: String(outcome.meta.exc) };
      const verdict = runner!.classify(toObservation(outcome));
      return { ok: verdict.ok, error_kind: verdict.errorKind };
    },
  };
}

function correlation(outcome: Outcome, keys: readonly string[]): { key: string; id: string } | undefined {
  for (const key of keys) {
    const value = outcome.meta?.[key];
    if (typeof value === "string" && value.trim()) return { key, id: value.trim() };
  }
  return undefined;
}

function firstToken(outcome: Outcome): number | undefined {
  return outcome.metrics?.first_token_ms;
}

interface PerfRequest {
  outcome: Outcome;
  ok?: boolean;
  errorKind?: string;
}

function percentileOutcome(
  outcomes: PerfRequest[],
  quantile: number,
  correlationKeys: readonly string[],
): PerfRequest | undefined {
  const values = outcomes.filter((item) => correlation(item.outcome, correlationKeys)).sort(
    (left, right) => (firstToken(left.outcome) ?? left.outcome.duration_ms)
      - (firstToken(right.outcome) ?? right.outcome.duration_ms),
  );
  if (!values.length) return undefined;
  return values[Math.min(values.length - 1, Math.floor(quantile * values.length))];
}

export function selectPerfSamples(run: Run, limit: number, correlationKeys: readonly string[]): Array<{
  armRunId: string;
  correlationKey: string;
  correlationId: string;
  outcome: Outcome;
  errorKind?: string;
}> {
  if (limit <= 0) return [];
  const selected: Array<{
    armRunId: string;
    correlationKey: string;
    correlationId: string;
    outcome: Outcome;
    errorKind?: string;
  }> = [];
  const seen = new Set<string>();
  for (const execution of run.executions) {
    const completed = new Set(execution.requests.filter(item => item.state === "finished").map(item => item.operation_run_id));
    const outcomes: PerfRequest[] = execution.operation_runs.filter(item => completed.has(item.id)).map(item => ({
      outcome: item.outcome,
      ok: execution.evaluations[item.id]?.ok,
      errorKind: execution.evaluations[item.id]?.error_kind,
    }));
    const slowest = [...outcomes].filter(
      (item) => correlation(item.outcome, correlationKeys),
    ).sort(
      (left, right) => (firstToken(right.outcome) ?? right.outcome.duration_ms)
        - (firstToken(left.outcome) ?? left.outcome.duration_ms),
    );
    const candidates = [
      percentileOutcome(outcomes, 1, correlationKeys),
      percentileOutcome(outcomes, 0.95, correlationKeys),
      outcomes.find(
        (item) => item.ok === false && correlation(item.outcome, correlationKeys),
      ),
      ...slowest,
    ];
    for (const candidate of candidates) {
      const correlated = candidate && correlation(candidate.outcome, correlationKeys);
      if (!candidate || !correlated || seen.has(correlated.id)) continue;
      seen.add(correlated.id);
      selected.push({
        armRunId: execution.id,
        correlationKey: correlated.key,
        correlationId: correlated.id,
        outcome: candidate.outcome,
        errorKind: candidate.errorKind,
      });
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

async function collectCorrelatedEvidence(input: {
  run: Run;
  limit: number;
  namespace: string;
  kubeconfig?: string;
  context?: string;
  profileName: string;
  services: readonly string[];
  correlationKeys: readonly string[];
  plugin: PluginDefinition;
  commandContext: CommandContext;
}): Promise<PerfEvidenceSample[]> {
  const samples: PerfEvidenceSample[] = [];
  for (const selected of selectPerfSamples(
    input.run,
    input.limit,
    input.correlationKeys,
  )) {
    if (input.commandContext.signal.aborted) break;
    writeOutput(`[perf] 正在采集代表请求的 Trace / Log（${samples.length + 1}/${input.limit}）…\n`, process.stderr);
    const trace = await traceCommand.run(input.commandContext, {
      bizIds: [selected.correlationId],
      namespace: input.namespace,
    });
    input.commandContext.artifacts.add(trace.artifacts);
    const log = trace.status === CommandStatus.Cancelled ? undefined : await logCommand.run(input.commandContext, {
      bizIds: [selected.correlationId],
      namespace: input.namespace,
      services: input.services,
      sinceTime: input.run.executions.find((execution) => execution.id === selected.armRunId)?.started_at,
    });
    if (log) input.commandContext.artifacts.add(log.artifacts);
    samples.push({
      armRunId: selected.armRunId,
      caseId: selected.outcome.case_id,
      correlationKey: selected.correlationKey,
      correlationId: selected.correlationId,
      firstTokenMs: firstToken(selected.outcome),
      durationMs: selected.outcome.duration_ms,
      errorKind: selected.errorKind,
      trace,
      log,
    });
  }
  return samples;
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
  const loads = perfLoadPlans(config);
  const selected = selectPerfProvider(plugin.services, config.service);
  const provider = selected.service;
  const kube = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!kube) return { status: CommandStatus.Cancelled, artifacts: [] };
  const executor = createKubernetesExecutor(kube);
  const authorization = resolveKubernetesCommandContext(executor, commandContext).access;
  const scenarios = await loadPerfScenarios(selected, () => {
    const options = {
      service: provider, capability: selected.extension,
      config: commandContext.profile.pluginConfig, clients: commandContext.clients, signal: commandContext.signal,
    };
    return selected.extension.access.kubernetes?.length
      ? openPluginContext(executor, {
        namespace: kube.kubernetes.namespace, kubeconfig: kube.kubernetes.kubeconfig, context: kube.kubernetes.context,
      }, { ...options, command: "doctor perf scenarios", authorization })
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
        command: "doctor perf identity",
        authorization,
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

  const managed = await openPluginContext(executor, {
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
  }, {
    config: commandContext.profile.pluginConfig,
    service: runnerProvider.service,
    endpoint: runnerProvider.factory.endpoint,
    capability: runnerProvider.factory,
    command: "doctor perf",
    signal: commandContext.signal,
    clients: commandContext.clients,
    authorization,
  });

  const unknownMetric = declaredScenario.observability.metricServices.filter(
    (service) => !plugin.services.extensions(METRIC_CONFIGURATION_KIND).some(provider => provider.service.name === plugin.services.find(service)?.name),
  );
  const unknownLog = declaredScenario.observability.logServices.filter(
    (service) => !plugin.services.find(service)?.logs,
  );
  if (unknownMetric.length || unknownLog.length) {
    await managed.dispose();
    throw new Error([
      unknownMetric.length ? `metric capability 缺失: ${unknownMetric.join(", ")}` : "",
      unknownLog.length ? `log capability 缺失: ${unknownLog.join(", ")}` : "",
    ].filter(Boolean).join("；"));
  }
  if (!caseMix.length
    || !declaredScenario.observability.metricServices.length
    || !declaredScenario.observability.logServices.length
    || !declaredScenario.observability.correlationKeys.length) {
    await managed.dispose();
    throw new Error("Service perf scenario 必须选择 Case 并提供 Metric/Log Service 和 correlation keys");
  }
  let artifact: ReturnType<typeof createPerfArtifact>;
  try {
    artifact = createPerfArtifact(config);
  } catch (error) {
    await managed.dispose();
    throw error;
  }
  const outputDir = artifact.path;
  commandContext.artifacts.add({ command: "perf", path: outputDir });

  const metricController = new AbortController();
  let markMetricStarted!: () => void;
  let rejectMetricStart!: (error: Error) => void;
  let metricStarted = false;
  const metricReady = new Promise<void>((resolveReady, rejectReady) => {
    markMetricStarted = () => {
      metricStarted = true;
      resolveReady();
    };
    rejectMetricStart = rejectReady;
  });
  writeOutput("[perf] 正在启动 Metric 采集窗口…\n", process.stderr);
  const metricPromise = metricCommand.run(commandContext, {
    services: declaredScenario.observability.metricServices,
    watch: "until-interrupt",
    interval: opts.interval ?? "5s",
    prometheus: opts.prometheus,
    namespace: kube.kubernetes.namespace,
    window: { signal: metricController.signal, onWindowStart: markMetricStarted },
  });
  metricPromise.then((result) => {
    if (!metricStarted) rejectMetricStart(new Error(`Metric 采集窗口启动失败（${result.status}）`));
  }, (error) => {
    if (!metricStarted) rejectMetricStart(error instanceof Error ? error : new Error(String(error)));
  });

  let run: Run | undefined;
  let loadError: unknown;
  let metric: CommandResult<void>;
  try {
    await metricReady;
    writeOutput(`[perf] Metric 已就绪；开始并发 ${config.levels.join(" → ")}\n`, process.stderr);
    run = await new Engine({
      name: `doctor-${provider.name}-${declaredScenario.id}`,
      service: managed.target.service,
      ...perfAdapterFromCaseFactory(`${runnerProvider.service.name}/${runnerProvider.source.id}`, () => createCaseRunner(runnerProvider.factory, managed, {
        caseSetId: caseSet.caseset,
        timeoutMs: config.requestTimeoutMs,
        requestIdentity,
      })),
      caseSet,
      caseMix,
      loads,
      signal: commandContext.signal,
      onArmStart: (context) => {
        writeOutput(`[perf] 开始 ${context.arm.id}\n${formatPerfCaseMix(caseSet, caseMix)}`, process.stderr);
      },
    }).run();
  } catch (error) {
    loadError = error;
  } finally {
    metricController.abort(commandContext.signal.aborted ? commandContext.signal.reason : undefined);
    writeOutput("[perf] 正在等待 Metric 采集收尾…\n", process.stderr);
    try {
      // Join the child before closing the parent's scope, even when parent cleanup fails.
      metric = await metricPromise;
      commandContext.artifacts.add(metric.artifacts);
    } finally {
      writeOutput("[perf] 正在释放请求资源…\n", process.stderr);
      await managed.dispose();
    }
  }
  if (loadError) {
    if (commandContext.signal.aborted) return { status: CommandStatus.Cancelled, artifacts: commandContext.artifacts.list() };
    throw loadError;
  }
  if (!run) throw new Error("Perf Harness 未形成 Run");
  writeOutput("[perf] 正在保存负载结果…\n", process.stderr);
  writeRunData(run, outputDir);
  const samples = await collectCorrelatedEvidence({
    run,
    limit: config.traceSamples,
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
    profileName: kube.profileName,
    services: declaredScenario.observability.logServices,
    correlationKeys: declaredScenario.observability.correlationKeys,
    plugin,
    commandContext,
  });
  const result: PerfResult = {
    run,
    outputDir,
    metric,
    samples,
    caseFacets: caseSet.facets,
  };
  const statuses = [run.passed ? CommandStatus.Ok : CommandStatus.Partial, metric.status, ...samples.flatMap((sample) => (
    [sample.trace.status, ...(sample.log ? [sample.log.status] : [])]
  ))];
  return { status: commandContext.signal.aborted ? CommandStatus.Cancelled : aggregateCommandStatus(statuses), output: result, artifacts: commandContext.artifacts.list() };
}
