import { randomUUID } from "node:crypto";
import type { Case, CaseSet } from "@compforge/spec-case/model";
import type {
  PluginDefinition,
  ServiceCaseObservation,
  ServiceCaseRunner,
  ServiceRequestIdentity,
} from "@compforge/doctor-plugin";
import { CommandStatus, aggregateCommandStatus, type CommandContext, type CommandResult } from "../command";
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
import { traceCommand } from "../collect/trace/command";
import { logCommand } from "../collect/log/command";
import { dataServicesForBizQuery } from "../collect/data";
import { dataCommand } from "../collect/data/command";
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
    },
    endpoint: directoryService.capabilities.tenantDirectory.endpoint,
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

function collected(result: CommandResult<void>, context: CommandContext): EvalEvidenceResult {
  context.artifacts.include(result.artifacts);
  return { status: result.status, artifacts: result.artifacts,
    reason: "reason" in result ? result.reason : undefined };
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
  if (!input.correlations.length || input.commandContext.signal.aborted) {
    const reason = "Case Observation 未提供可识别的关联 ID";
    return { trace: unavailable(reason), log: unavailable(reason), data: unavailable(reason) };
  }
  let trace = unavailable("当前 Plugin 未声明 traceId capability");
  let log = unavailable("当前 Plugin 未同时声明 traceId/log capability");
  let data = unavailable("当前 Plugin 没有可从 biz_id 到达的 Inspect contribution");

  if (input.plugin.services.servicesWith("traceId").length) {
    try {
      trace = collected(await traceCommand.run(input.commandContext, {
        bizIds: [...input.correlations],
        namespace: input.namespace,
      }), input.commandContext);
    } catch (error) {
      trace = { status: CommandStatus.Failed, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const logServices = input.plugin.services.servicesWith("log")
    .filter((service) => service.capabilities.log.default)
    .map((service) => service.name);
  if (!input.commandContext.signal.aborted && input.plugin.services.servicesWith("traceId").length && logServices.length) {
    try {
      log = collected(await logCommand.run(input.commandContext, {
        bizIds: [...input.correlations],
        namespace: input.namespace,
        services: logServices.join(","),
        sinceTime: input.startedAt,
      }), input.commandContext);
    } catch (error) {
      log = { status: CommandStatus.Failed, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  const dataServices = dataServicesForBizQuery(input.plugin.services);
  if (!input.commandContext.signal.aborted && dataServices.length) {
    try {
      data = collected(await dataCommand.run(input.commandContext, {
        bizIds: [...input.correlations],
        namespace: input.namespace,
        services: dataServices.join(","),
      }), input.commandContext);
    } catch (error) {
      data = { status: CommandStatus.Failed, reason: error instanceof Error ? error.message : String(error) };
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
): Promise<CommandResult<EvalRun>> {
  const config = resolveEvalConfig(opts);
  const provider = selectEvalProvider(plugin, config.service);
  const caseSet: CaseSet = selectEvalCaseSet(provider, config.caseset);
  const cases = selectEvalCases(caseSet, config.caseIds);
  const kube = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
  if (!kube) return { status: CommandStatus.Cancelled, artifacts: [] };
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
    return { status: CommandStatus.Cancelled, artifacts: [] };
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
    return { status: CommandStatus.Cancelled, artifacts: [] };
  }

  const managed = await openPluginContext(executor, {
    namespace: kube.kubernetes.namespace,
    kubeconfig: kube.kubernetes.kubeconfig,
    context: kube.kubernetes.context,
  }, {
    env: kube.profileName,
    config: commandContext.profile.pluginConfig,
    service: { name: provider.name },
    endpoint: provider.capabilities.case.endpoint,
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
  const signal = commandContext.signal;
  let runner: ServiceCaseRunner | undefined;
  let results: EvalCaseResult[] = [];
  let lifecycleError: string | undefined;
  try {
    runner = await provider.capabilities.case.createRunner(managed, {
      caseSetId: caseSet.caseset,
      timeoutMs: config.requestTimeoutMs,
      requestIdentity,
    });
    await runner.setup?.({ runId, signal: signal });
    results = await executeEvalCases(runner, cases, runId, signal);
  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await runner?.deactivate?.({ runId, signal: signal });
      await runner?.cleanup?.({ runId, signal: signal });
    } catch (error) {
      lifecycleError ??= error instanceof Error ? error.message : String(error);
    }
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
    schema: "doctor-eval/v2",
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
  if (signal.aborted) return { status: CommandStatus.Cancelled, output: run, artifacts: commandContext.artifacts.list() };
  const statuses = results.map((item) => item.observation ? CommandStatus.Ok : CommandStatus.Failed);
  if (lifecycleError || results.length !== cases.length) statuses.push(CommandStatus.Failed);
  statuses.push(...Object.values(evidence).flatMap((item) => item.status === "unavailable" ? [] : [item.status]));
  return { status: aggregateCommandStatus(statuses), output: run, artifacts: commandContext.artifacts.list() };
}
