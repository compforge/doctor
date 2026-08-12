import { join } from "node:path";
import {
  Engine,
  rampHold,
  writeRunData,
  type Outcome,
  type Run,
  type TimedOutcome,
  type Workload,
} from "@compforge/perf-harness";
import type {
  PluginDefinition,
  ServiceCaseAsset,
  ServiceCaseObservation,
  ServiceCaseRunner,
  ServiceDefinition,
  ServiceRequestIdentity,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../command/kubernetes-target";
import { runCollectLog } from "../collect/log";
import { runCollectMetric } from "../collect/metric";
import { runCollectTrace } from "../collect/trace";
import { openPluginContext } from "../plugin/context";
import { resolveKubernetesCommandContext } from "../command";
import { approvalDeniedReason } from "../command/approval";
import { resolveApprovalGate } from "../terminal/approval";
import { terminalStderr, terminalStdout } from "../terminal/output";
import { promptListedChoice } from "../terminal/selection";
import {
  PERF_MAX_CONCURRENCY_OPTIONS,
  perfLevelsThrough,
  resolvePerfConfig,
} from "./config";
import { resolvePerfRequestIdentity } from "./identity";
import type { PerfCliOpts, PerfEvidenceSample, PerfResult } from "./model";
import { deliverPerfBundle, preparePerfOutput } from "./output";
import { writePerfReport } from "./report";

export * from "./config";
export * from "./identity";
export * from "./model";
export * from "./output";
export * from "./report";

type PerfProvider = ServiceDefinition & {
  capabilities: ServiceDefinition["capabilities"]
    & Required<Pick<ServiceDefinition["capabilities"], "case" | "perf">>;
};

export function formatPerfCaseMix(
  caseMix: readonly { case: ServiceCaseAsset; weight: number }[],
): string {
  return caseMix.map(({ case: selectedCase, weight }) => {
    const facets = Object.entries(selectedCase.facets ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    return `[perf]   case=${selectedCase.id} weight=${weight}${facets ? ` facets=${facets}` : ""}\n`;
  }).join("");
}

function selectProvider(plugin: PluginDefinition, requested: string | undefined): PerfProvider {
  if (requested) {
    const service = plugin.services.findWith(requested, "perf");
    if (!service) throw new Error(`Service '${requested}' 未声明 perf capability`);
    if (!service.capabilities.case) throw new Error(`Service '${requested}' 未声明 case capability`);
    return service as PerfProvider;
  }
  const providers = plugin.services.servicesWith("perf").filter(
    (service) => service.capabilities.case !== undefined,
  );
  if (providers.length !== 1) {
    throw new Error(`当前 Plugin 有 ${providers.length} 个同时声明 case/perf 的 provider；请使用 --service 指定`);
  }
  return providers[0] as PerfProvider;
}

function toObservation(outcome: Outcome): ServiceCaseObservation {
  return {
    status: outcome.status,
    durationMs: outcome.duration_ms,
    events: outcome.events,
    nbytes: outcome.nbytes,
    metrics: outcome.metrics,
    meta: outcome.meta,
    errorKind: outcome.error_kind,
  };
}

export function workloadFromCaseRunner(runner: ServiceCaseRunner): Workload {
  return {
    setup: async ({ run_id, signal }) => {
      await runner.setup?.({ runId: run_id, signal });
    },
    fire: async ({ case: perfCase, run_id, signal }) => {
      const observation = await runner.trigger({
        case: { id: perfCase.id, input: perfCase.input, facets: perfCase.facets },
        runId: run_id,
        signal,
      });
      return {
        status: observation.status,
        duration_ms: observation.durationMs,
        events: observation.events,
        nbytes: observation.nbytes,
        metrics: observation.metrics ? { ...observation.metrics } : undefined,
        meta: observation.meta ? { ...observation.meta } : undefined,
        error_kind: observation.errorKind,
      };
    },
    judge: (outcome) => {
      if (outcome.meta?.exc) return { ok: false, error_kind: String(outcome.meta.exc) };
      const verdict = runner.classify(toObservation(outcome));
      return { ok: verdict.ok, error_kind: verdict.errorKind };
    },
    deactivate: async ({ run_id, signal }) => {
      await runner.deactivate?.({ runId: run_id, signal });
    },
    cleanup: async ({ run_id, signal }) => {
      await runner.cleanup?.({ runId: run_id, signal });
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

function percentileOutcome(
  outcomes: TimedOutcome[],
  quantile: number,
  correlationKeys: readonly string[],
): TimedOutcome | undefined {
  const values = outcomes.filter((item) => correlation(item.outcome, correlationKeys)).sort(
    (left, right) => (firstToken(left.outcome) ?? left.outcome.duration_ms)
      - (firstToken(right.outcome) ?? right.outcome.duration_ms),
  );
  if (!values.length) return undefined;
  return values[Math.min(values.length - 1, Math.floor(quantile * values.length))];
}

export function selectPerfSamples(run: Run, limit: number, correlationKeys: readonly string[]): Array<{
  trialId: string;
  correlationKey: string;
  correlationId: string;
  outcome: Outcome;
}> {
  if (limit <= 0) return [];
  const selected: Array<{
    trialId: string;
    correlationKey: string;
    correlationId: string;
    outcome: Outcome;
  }> = [];
  const seen = new Set<string>();
  for (const trial of run.trials) {
    const slowest = [...trial.outcomes].filter(
      (item) => correlation(item.outcome, correlationKeys),
    ).sort(
      (left, right) => (firstToken(right.outcome) ?? right.outcome.duration_ms)
        - (firstToken(left.outcome) ?? left.outcome.duration_ms),
    );
    const candidates = [
      percentileOutcome(trial.outcomes, 1, correlationKeys),
      percentileOutcome(trial.outcomes, 0.95, correlationKeys),
      trial.outcomes.find(
        (item) => item.outcome.ok === false && correlation(item.outcome, correlationKeys),
      ),
      ...slowest,
    ];
    for (const candidate of candidates) {
      const correlated = candidate && correlation(candidate.outcome, correlationKeys);
      if (!candidate || !correlated || seen.has(correlated.id)) continue;
      seen.add(correlated.id);
      selected.push({
        trialId: trial.id,
        correlationKey: correlated.key,
        correlationId: correlated.id,
        outcome: candidate.outcome,
      });
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

async function collectCorrelatedEvidence(input: {
  run: Run;
  limit: number;
  outputDir: string;
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
  for (const [index, selected] of selectPerfSamples(
    input.run,
    input.limit,
    input.correlationKeys,
  ).entries()) {
    const prefix = `sample-${String(index + 1).padStart(2, "0")}-${selected.correlationId.slice(0, 12)}`;
    const tracePath = join(input.outputDir, `${prefix}-trace.html`);
    const logPath = join(input.outputDir, `${prefix}-log.html`);
    const traceCode = await runCollectTrace({
      bizId: selected.correlationId,
      namespace: input.namespace,
      kubeconfig: input.kubeconfig,
      context: input.context,
      profile: input.profileName,
      pageSize: "1000",
      format: "html",
      output: tracePath,
    }, input.plugin, input.commandContext);
    const logCode = await runCollectLog({
      bizId: selected.correlationId,
      namespace: input.namespace,
      kubeconfig: input.kubeconfig,
      context: input.context,
      profile: input.profileName,
      services: input.services.join(","),
      sinceTime: input.run.trials.find((trial) => trial.id === selected.trialId)?.started_at,
      format: "html",
      output: logPath,
    }, input.plugin, input.commandContext);
    samples.push({
      trialId: selected.trialId,
      caseId: selected.outcome.case_id,
      correlationKey: selected.correlationKey,
      correlationId: selected.correlationId,
      firstTokenMs: firstToken(selected.outcome),
      durationMs: selected.outcome.duration_ms,
      errorKind: selected.outcome.error_kind,
      tracePath,
      traceCode,
      logPath,
      logCode,
    });
  }
  return samples;
}

export async function runPerf(
  opts: PerfCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<number> {
  const config = resolvePerfConfig(opts);
  const provider = selectProvider(plugin, config.service);
  const scenario = config.scenario ?? provider.capabilities.perf.scenarios[0]?.id;
  const declaredScenario = provider.capabilities.perf.scenarios.find((item) => item.id === scenario);
  if (!declaredScenario) throw new Error(`Service '${provider.name}' 未声明 perf scenario '${scenario}'`);
  const caseSet = provider.capabilities.case.caseSets.find(
    (candidate) => candidate.id === declaredScenario.caseSetId,
  );
  if (!caseSet) {
    throw new Error(`Perf scenario '${scenario}' 引用了未知 CaseSet '${declaredScenario.caseSetId}'`);
  }
  const caseMix = declaredScenario.cases.map((selection) => {
    const selectedCase = caseSet.cases.find((candidate) => candidate.id === selection.caseId);
    if (!selectedCase) {
      throw new Error(`Perf scenario '${scenario}' 引用了未知 Case '${selection.caseId}'`);
    }
    return { case: selectedCase, weight: selection.weight ?? 1 };
  });

  if (!opts.levels?.trim() && process.stdin.isTTY && process.stdout.isTTY) {
    terminalStdout.info(
      `[perf] 可选最高并发：${PERF_MAX_CONCURRENCY_OPTIONS.join(" / ")}（默认 20）\n`,
    );
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
    if (maxConcurrency === undefined) return 130;
    config.levels = perfLevelsThrough(maxConcurrency);
  }

  const kube = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!kube) return 130;

  const executor = createKubernetesExecutor(kube);
  const authorization = resolveKubernetesCommandContext(executor, commandContext).access;
  let requestIdentity: ServiceRequestIdentity | undefined;
  const identityRequirement = provider.capabilities.case.requestIdentity;
  if (identityRequirement) {
    const configured = identityRequirement.configured(commandContext.profile.pluginConfig);
    const tenantId = configured.tenantId?.trim();
    const userId = configured.userId?.trim();
    if (tenantId && userId) {
      requestIdentity = { tenantId, userId };
    } else {
      if (!(process.stdin.isTTY && process.stdout.isTTY)) {
        throw new Error("非交互环境的 Perf Case 必须由 Plugin profile 配置提供 tenant_id 和 user_id");
      }
      const directoryService = plugin.services.findWith(
        identityRequirement.directoryService,
        "tenantDirectory",
      );
      if (!directoryService) {
        throw new Error(
          `Service '${identityRequirement.directoryService}' 未声明 tenantDirectory capability`,
        );
      }
      const directoryContext = await openPluginContext(executor, {
        namespace: kube.kubernetes.namespace,
        kubeconfig: kube.kubernetes.kubeconfig,
        context: kube.kubernetes.context,
      }, {
        env: kube.profileName,
        config: commandContext.profile.pluginConfig,
        service: {
          name: directoryService.name,
          port: directoryService.capabilities.tenantDirectory.endpoint.port,
        },
        capability: directoryService.capabilities.tenantDirectory,
        command: "doctor perf identity",
        authorization,
      });
      try {
        requestIdentity = await resolvePerfRequestIdentity({
          configured: { tenantId, userId },
          directory: directoryService.capabilities.tenantDirectory.create(directoryContext),
        });
      } finally {
        await directoryContext.dispose();
      }
      if (!requestIdentity) {
        terminalStderr.warning("[perf] 已取消身份选择\n");
        return 130;
      }
    }
    terminalStdout.write(
      `[perf] identity: tenant=${requestIdentity.tenantId} user=${requestIdentity.userId}\n`,
    );
  }

  const decision = await resolveApprovalGate(opts)({
    id: "perf-load",
    risk: "disrupt",
    title: `执行 ${declaredScenario.title} 压测`,
    purpose: declaredScenario.description,
    target: `${kube.profileName}/${kube.kubernetes.namespace}/${provider.name}`
      + ` · concurrency ${config.levels.join(" → ")}`,
    impact: [
      `最多发起 ${config.levels.length * config.maxRequests} 个业务请求（每档最多 ${config.maxRequests}）`,
      "请求会写入业务数据库、日志和 trace，并可能产生模型调用费用",
      `错误率达到 ${(config.abortErrorRate * 100).toFixed(0)}%（至少 ${config.breakerMinN} 个样本）时停止当前档`,
      "压测可能放大目标 Service 及其下游的延迟和资源压力",
    ],
  });
  if (!decision.approved) {
    terminalStderr.warning(`[perf] ${approvalDeniedReason(decision.source)}\n`);
    return 130;
  }

  const managed = await openPluginContext(executor, {
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
  }, {
    env: kube.profileName,
    config: commandContext.profile.pluginConfig,
    service: { name: provider.name, port: provider.capabilities.case.endpoint.port },
    capability: provider.capabilities.case,
    command: "doctor perf",
    authorization,
  });
  let runner: ServiceCaseRunner;
  try {
    runner = await provider.capabilities.case.createRunner(managed, {
      caseSetId: caseSet.id,
      timeoutMs: config.requestTimeoutMs,
      requestIdentity,
    });
  } catch (error) {
    await managed.dispose();
    throw error;
  }

  const unknownMetric = declaredScenario.observability.metricServices.filter(
    (service) => !plugin.services.findWith(service, "metric"),
  );
  const unknownLog = declaredScenario.observability.logServices.filter(
    (service) => !plugin.services.findWith(service, "log"),
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
  let output: ReturnType<typeof preparePerfOutput>;
  try {
    output = preparePerfOutput(config);
  } catch (error) {
    await managed.dispose();
    throw error;
  }
  const { outputDir, archivePath } = output;

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
  const metricPath = join(outputDir, "metric.html");
  const metricPromise = runCollectMetric({
    services: declaredScenario.observability.metricServices.join(","),
    watch: "until-interrupt",
    interval: opts.interval ?? "5s",
    prometheus: opts.prometheus,
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
    profile: kube.profileName,
    output: metricPath,
  }, plugin, commandContext, executor, {
    signal: metricController.signal,
    onWindowStart: markMetricStarted,
  });
  metricPromise.then((code) => {
    if (!metricStarted) rejectMetricStart(new Error(`Metric 采集窗口启动失败（exit ${code}）`));
  }, (error) => {
    if (!metricStarted) rejectMetricStart(error instanceof Error ? error : new Error(String(error)));
  });

  const loadController = new AbortController();
  const onInterrupt = () => {
    loadController.abort(new Error("doctor perf interrupted"));
    metricController.abort();
  };
  process.once("SIGINT", onInterrupt);
  let run: Run | undefined;
  let loadError: unknown;
  try {
    await metricReady;
    terminalStdout.write(`[perf] metric window ready; starting ${config.levels.join(" → ")} concurrency\n`);
    run = await new Engine({
      name: `doctor-${provider.name}-${declaredScenario.id}`,
      subject: { name: provider.name, target: { service: provider.name } },
      workload: workloadFromCaseRunner(runner),
      caseMix,
      loads: config.levels.map((level) => rampHold("closed", level, config.rampSeconds, config.holdSeconds, {
        max_requests: config.maxRequests,
        abort_on_error_rate: config.abortErrorRate,
        breaker_min_n: config.breakerMinN,
        graceful_stop_s: config.gracefulStopSeconds,
      })),
      signal: loadController.signal,
      onTrialStart: (context) => {
        terminalStdout.write(`[perf] trial ${context.arm.id}; case mix:\n${formatPerfCaseMix(caseMix)}`);
      },
    }).run();
  } catch (error) {
    loadError = error;
  } finally {
    metricController.abort();
    process.removeListener("SIGINT", onInterrupt);
    await managed.dispose();
  }
  const metricCode = await metricPromise;
  if (loadError) throw loadError;
  if (!run) throw new Error("Perf Harness 未形成 Run");
  writeRunData(run, outputDir);
  const samples = await collectCorrelatedEvidence({
    run,
    limit: config.traceSamples,
    outputDir,
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
    metricPath,
    metricCode,
    samples,
    caseFacets: caseSet.facets,
  };
  const reportPath = writePerfReport(result);
  const passed = run.passed && metricCode === 0;
  if (archivePath) {
    const packed = await deliverPerfBundle(output);
    if (!packed) throw new Error("Perf Bundle 输出状态不完整");
    if (!packed.ok) {
      terminalStderr.error(
        `[perf] Bundle 打包失败：${packed.stderr.trim() || `exit=${packed.exitCode}`}；原始产物保留在 ${outputDir}\n`,
      );
      return 1;
    }
    terminalStdout.result(passed, `[perf] bundle: ${archivePath}\n`);
    return passed ? 0 : 1;
  }
  terminalStdout.result(passed, `[perf] report: ${reportPath}\n`);
  return passed ? 0 : 1;
}
