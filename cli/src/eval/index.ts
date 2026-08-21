import { randomUUID } from "node:crypto";
import type { Case, CaseSet } from "@compforge/spec-case/model";
import type {
  PluginDefinition,
  ServiceCaseObservation,
  ServiceCaseRunner,
  ServiceRequestIdentity,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../command";
import { approvalDeniedReason } from "../command/approval";
import { resolveApprovalGate } from "../terminal/approval";
import { terminalStderr, terminalStdout } from "../terminal/output";
import { openPluginContext } from "../plugin/context";
import { resolveCaseRequestIdentity } from "../case";
import { runCollectTrace } from "../collect/trace";
import { runCollectLog } from "../collect/log";
import { runCollectData, dataServicesForBizQuery } from "../collect/data";
import {
  resolveEvalConfig,
  selectEvalCases,
  selectEvalCaseSet,
  selectEvalProvider,
  type EvalProvider,
} from "./config";
import type {
  EvalCaseResult,
  EvalCliOpts,
  EvalEvidenceCollection,
  EvalEvidenceResult,
  EvalRun,
} from "./model";
import { createEvalArtifact, writeEvalArtifact } from "./output";

export * from "./config";
export * from "./model";
export * from "./output";

const CORRELATION_KEYS = ["trace_id", "message_id", "conversation_id", "task_id"] as const;

function correlation(observation: ServiceCaseObservation): EvalCaseResult["correlation"] {
  for (const key of CORRELATION_KEYS) {
    const value = observation.meta?.[key];
    if (typeof value === "string" && value.trim()) return { key, id: value.trim() };
  }
  return undefined;
}

async function resolveEvalRequestIdentity(input: {
  provider: EvalProvider;
  plugin: PluginDefinition;
  executor: ReturnType<typeof createKubernetesExecutor>;
  namespace: string;
  kubeconfig?: string;
  context?: string;
  profileName: string;
  commandContext: CommandContext;
}): Promise<ServiceRequestIdentity | undefined> {
  const requirement = input.provider.capabilities.case.requestIdentity;
  if (!requirement) return undefined;
  const configured = requirement.configured(input.commandContext.profile.pluginConfig);
  const tenantId = configured.tenantId?.trim();
  const userId = configured.userId?.trim();
  if (tenantId && userId) return { tenantId, userId };
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error("非交互环境的 Eval Case 必须由 Plugin profile 配置提供 tenant_id 和 user_id");
  }
  const directoryService = input.plugin.services.findWith(
    requirement.directoryService,
    "tenantDirectory",
  );
  if (!directoryService) {
    throw new Error(`Service '${requirement.directoryService}' 未声明 tenantDirectory capability`);
  }
  const managed = await openPluginContext(input.executor, {
    namespace: input.namespace,
    kubeconfig: input.kubeconfig,
    context: input.context,
  }, {
    env: input.profileName,
    config: input.commandContext.profile.pluginConfig,
    service: {
      name: directoryService.name,
      port: directoryService.capabilities.tenantDirectory.endpoint.port,
    },
    capability: directoryService.capabilities.tenantDirectory,
    command: "doctor eval identity",
    authorization: resolveKubernetesCommandContext(input.executor, input.commandContext).access,
  });
  try {
    return await resolveCaseRequestIdentity({
      configured: { tenantId, userId },
      directory: directoryService.capabilities.tenantDirectory.create(managed),
      commandLabel: "Eval",
      logPrefix: "eval",
    });
  } finally {
    await managed.dispose();
  }
}

export async function executeEvalCases(
  runner: ServiceCaseRunner,
  cases: readonly Case[],
  runId: string,
  signal: AbortSignal,
): Promise<EvalCaseResult[]> {
  const results: EvalCaseResult[] = [];
  for (const selected of cases) {
    if (signal.aborted) break;
    const startedAt = new Date().toISOString();
    terminalStdout.write(`[eval] case ${selected.id}…\n`);
    try {
      const observation = await runner.run({ input: selected, runId, signal });
      const protocol = runner.classify(observation);
      results.push({
        caseId: selected.id,
        facets: selected.facets,
        startedAt,
        finishedAt: new Date().toISOString(),
        observation,
        protocol,
        correlation: correlation(observation),
      });
      terminalStdout.write(
        `[eval] case ${selected.id}: ${protocol.ok ? "ok" : protocol.errorKind ?? "failed"}`
        + ` (${observation.durationMs.toFixed(0)}ms)\n`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({
        caseId: selected.id,
        facets: selected.facets,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: reason,
      });
      terminalStderr.error(`[eval] case ${selected.id}: ${reason}\n`);
    }
  }
  return results;
}

function unavailable(reason: string): EvalEvidenceResult {
  return { status: "unavailable", reason };
}

function collected(code: number): EvalEvidenceResult {
  return code === 0
    ? { status: "collected", exitCode: 0 }
    : { status: "failed", exitCode: code, reason: `collector exit ${code}` };
}

async function collectEvalEvidence(input: {
  correlations: readonly string[];
  startedAt: string;
  namespace: string;
  kubeconfig?: string;
  context?: string;
  profileName: string;
  plugin: PluginDefinition;
  commandContext: CommandContext;
}): Promise<EvalEvidenceCollection> {
  if (!input.correlations.length) {
    const reason = "Case Observation 未提供可识别的关联 ID";
    return { trace: unavailable(reason), log: unavailable(reason), data: unavailable(reason) };
  }
  let trace = unavailable("当前 Plugin 未声明 traceId capability");
  let log = unavailable("当前 Plugin 未同时声明 traceId/log capability");
  let data = unavailable("当前 Plugin 没有可从 biz_id 到达的 data capability");

  if (input.plugin.services.servicesWith("traceId").length) {
    try {
      trace = collected(await runCollectTrace({
        bizIds: [...input.correlations],
        namespace: input.namespace,
        kubeconfig: input.kubeconfig,
        context: input.context,
        profile: input.profileName,
        pageSize: "1000",
        format: "html",
      }, input.plugin, input.commandContext));
    } catch (error) {
      trace = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const logServices = input.plugin.services.servicesWith("log")
    .filter((service) => service.capabilities.log.default)
    .map((service) => service.name);
  if (input.plugin.services.servicesWith("traceId").length && logServices.length) {
    try {
      log = collected(await runCollectLog({
        bizIds: [...input.correlations],
        namespace: input.namespace,
        kubeconfig: input.kubeconfig,
        context: input.context,
        profile: input.profileName,
        services: logServices.join(","),
        sinceTime: input.startedAt,
        format: "html",
      }, input.plugin, input.commandContext));
    } catch (error) {
      log = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const dataServices = dataServicesForBizQuery(input.plugin.services);
  if (dataServices.length) {
    try {
      data = collected(await runCollectData({
        bizIds: [...input.correlations],
        namespace: input.namespace,
        kubeconfig: input.kubeconfig,
        context: input.context,
        profile: input.profileName,
        services: dataServices.join(","),
        format: "html",
      }, input.plugin, input.commandContext));
    } catch (error) {
      data = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return { trace, log, data };
}

/**
 * @spec Doctor Eval executes each selected canonical Case once and captures observations plus correlated evidence without scoring answer quality.
 * @link cli/docs/commands/eval.md
 */
export async function runEval(
  opts: EvalCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<number> {
  const config = resolveEvalConfig(opts);
  const provider = selectEvalProvider(plugin, config.service);
  const caseSet: CaseSet = selectEvalCaseSet(provider, config.caseset);
  const cases = selectEvalCases(caseSet, config.caseIds);
  const kube = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!kube) return 130;
  const executor = createKubernetesExecutor(kube);
  const requestIdentity = await resolveEvalRequestIdentity({
    provider,
    plugin,
    executor,
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
    profileName: kube.profileName,
    commandContext,
  });
  if (provider.capabilities.case.requestIdentity && !requestIdentity) {
    terminalStderr.warning("[eval] 已取消身份选择\n");
    return 130;
  }

  const decision = await resolveApprovalGate(opts)({
    id: "eval-cases",
    risk: "disrupt",
    title: `执行 CaseSet ${caseSet.caseset}`,
    purpose: caseSet.focus ?? "按 canonical CaseSet 触发真实业务请求并采集关联证据",
    target: `${kube.profileName}/${kube.kubernetes.namespace}/${provider.name}`,
    impact: [
      `顺序发起 ${cases.length} 个真实业务请求，每个 Case 执行一次`,
      "请求可能写入业务数据库、日志和 trace，并可能产生模型调用费用",
      "执行后读取关联的 Trace、Log 与业务 Data；不进行质量评分",
    ],
  });
  if (!decision.approved) {
    terminalStderr.warning(`[eval] ${approvalDeniedReason(decision.source)}\n`);
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
    command: "doctor eval",
    authorization: resolveKubernetesCommandContext(executor, commandContext).access,
  });
  let artifact: ReturnType<typeof createEvalArtifact>;
  try {
    artifact = createEvalArtifact(config);
  } catch (error) {
    await managed.dispose();
    throw error;
  }
  commandContext.artifacts.setReportName(config.bundleName);
  commandContext.artifacts.add("eval", artifact.path);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error("doctor eval interrupted"));
  process.once("SIGINT", onInterrupt);
  let runner: ServiceCaseRunner | undefined;
  let results: EvalCaseResult[] = [];
  let lifecycleError: string | undefined;
  try {
    runner = await provider.capabilities.case.createRunner(managed, {
      caseSetId: caseSet.caseset,
      timeoutMs: config.requestTimeoutMs,
      requestIdentity,
    });
    await runner.setup?.({ runId, signal: controller.signal });
    results = await executeEvalCases(runner, cases, runId, controller.signal);
  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await runner?.deactivate?.({ runId, signal: controller.signal });
      await runner?.cleanup?.({ runId, signal: controller.signal });
    } catch (error) {
      lifecycleError ??= error instanceof Error ? error.message : String(error);
    }
    process.removeListener("SIGINT", onInterrupt);
    await managed.dispose();
  }
  if (lifecycleError) terminalStderr.error(`[eval] runner lifecycle: ${lifecycleError}\n`);

  const correlations = [...new Set(results.flatMap((item) => item.correlation?.id ?? []))];
  const evidence = await collectEvalEvidence({
    correlations,
    startedAt,
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
    profileName: kube.profileName,
    plugin,
    commandContext,
  });
  const run: EvalRun = {
    schema: "doctor-eval/v1",
    runId,
    plugin: `${plugin.id}@${plugin.version}`,
    service: provider.name,
    caseset: caseSet.caseset,
    startedAt,
    finishedAt: new Date().toISOString(),
    cases: results,
    evidence,
  };
  writeEvalArtifact(artifact, run, caseSet, kube.profileName);
  if (controller.signal.aborted) return 130;
  const caseFailed = lifecycleError !== undefined
    || results.length !== cases.length
    || results.some((item) => item.protocol?.ok !== true);
  const evidenceFailed = Object.values(evidence).some((item) => item.status === "failed");
  return caseFailed || evidenceFailed ? 1 : 0;
}
