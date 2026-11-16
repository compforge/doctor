import { healthCheckScope, validateHealthProbeResult, type HealthCheckQuery, type HealthProbeResult } from "@compforge/doctor-plugin";
import { CommandInputError, CommandStatus, aggregateCommandStatus, defineCommand, type CommandContext, type CommandInput, type CommandResult } from "../command";
import { approvalDeniedReason } from "../command/approval";
import { prepareCommandRequirements } from "../command/prepare";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { commandOptions, type CommandHostOption } from "../command/options";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { parseCollectOutputFormat } from "../collect/composite";
import { serializeEvidence } from "../collect/serialize";
import { renderEvidence } from "../report/evidence";
import { isInteractive } from "../terminal/policy";
import { HealthInteraction } from "./interaction";
import { overviewServiceNames } from "../overview/options";
import { useLogger } from "../terminal/log";
import { healthProviders, type HealthProvider } from "./extensions";
import { selectHealthScope, selectHealthBusinessProviders } from "./selection";
import { runHealthSession, type HealthResult } from "./flow";
import { checkServiceCases } from "./cases/run";
import { prepareServiceCases } from "./cases/prepare";
import { caseCheckActions, casePrepareActions } from "./cases/runtime";
import { createHealthCaseApproval } from "./cases/approval";
import { buildHealthHtml, printHealth, writeHealthEvidence } from "./report";
import { healthScopes } from "./scopes";
import { createPluginOperationInvoker } from "../plugin/operation-invoker";
import { diagnosticMessage } from "../command/diagnostic";

export interface HealthCliOpts extends KubernetesCommandInput, HealthCheckQuery {
  scope?: string; services?: readonly string[]; userId?: string; output?: string; format?: string;
}
export function validateHealthOptions(opts: HealthCliOpts): void {
  for (const name of ["pod", "container"] as const) if (opts[name] !== undefined && !opts[name]?.trim()) throw new CommandInputError(`--${name} 需要非空名称`);
  healthScopes(opts.scope); overviewServiceNames(opts); parseCollectOutputFormat(opts.format);
}
interface HealthPreparation {
  input: HealthCliOpts; selected: readonly HealthProvider[];
  kube: NonNullable<Awaited<ReturnType<typeof resolveKubernetesCommandConfig>>>;
  executor: ReturnType<typeof createKubernetesExecutor>;
}
async function health(prepared: HealthPreparation, context: CommandContext): Promise<CommandResult<HealthResult>> {
  const { input, selected, kube, executor } = prepared;
  const query: HealthCheckQuery = { tenantId: input.tenantId, bizId: input.bizId, pod: input.pod, container: input.container };
  const interaction = new HealthInteraction(context);
  const invoke = createPluginOperationInvoker(context, executor, kube.kubernetes);
  const approve = createHealthCaseApproval(context, kube.kubernetes.namespace, interaction.approve);
  let snapshot: HealthResult | undefined;
  let directory: string | undefined;
  let result: HealthResult;
  try {
    result = await runHealthSession(selected, query, {
      signal: context.signal, stopped: () => interaction.stopped,
      selectBusinessProviders: providers => selectHealthBusinessProviders(providers, !input.services && isInteractive()),
      run: async (provider, check, checkpoint) => {
        const scope = healthCheckScope(check);
        const label = `${provider.name}/${check.id}`;
        useLogger("health").info(`执行 ${scope} 检查：${label}`);
        try {
          if (check.execution === "probe") {
            if (scope !== "self" || check.approval.risk !== "observe") {
              const decision = await interaction.approve({ id: `healthcheck:${provider.namespace}:${label}`, title: check.description, ...check.approval });
              if (!decision.approved) return { status: interaction.stopped || decision.source !== "prompt" ? "not-run" : "skipped", summary: approvalDeniedReason(decision.source) };
            }
            const save = (value: HealthProbeResult) => { validateHealthProbeResult(value); checkpoint(structuredClone({ status: value.status, summary: value.summary, evidence: value.evidence })); };
            const value = await invoke(provider.service, check, { ...query, checkpoint: save });
            validateHealthProbeResult(value); return { status: value.status, summary: value.summary, evidence: value.evidence };
          }
          const preparedCases = await prepareServiceCases(context.plugin, provider.service, [check], input.tenantId,
            casePrepareActions(context, executor, kube.kubernetes, input));
          const snapshots: import("./cases/run").CaseCheckResult[] = [];
          const cases = await checkServiceCases(preparedCases,
            caseCheckActions(context, executor, kube.kubernetes, directory!, value => {
              const index = snapshots.findIndex(item => item.bindingId === value.bindingId);
              if (index < 0) snapshots.push(value); else snapshots[index] = value;
              checkpoint({ cases: structuredClone(snapshots) });
            }, approve, interaction));
          const status = context.signal.aborted ? "cancelled"
            : cases.some(item => item.status === "failed") ? "failed"
            : cases.length > 0 && cases.every(item => item.status === "unavailable") ? "unavailable"
            : !cases.length || cases.some(item => item.status !== "passed" || item.truncated) ? "partial" : "passed";
          return { status, cases, summary: cases.length ? `${cases.length} 项 Case 消费关系检查` : "没有适用的 Case 消费关系，未取得请求证据" };
        } catch (error) {
          return { status: context.signal.aborted ? "cancelled" : "unavailable", summary: diagnosticMessage(error) };
        } finally { useLogger("health").info(`结束 ${scope} 检查：${label}`); }
      },
      show: current => { snapshot = current; directory = writeHealthEvidence(current, context, directory); },
    });
  } finally { if (snapshot) { writeHealthEvidence(snapshot, context, directory); printHealth(snapshot); } }
  const statuses = result.providers.flatMap(provider => [
    ...(provider.unsupported ? [CommandStatus.Partial] : []),
    ...provider.checks.map(check => check.status === "passed" ? CommandStatus.Ok
      : check.status === "cancelled" ? CommandStatus.Cancelled
      : check.status === "failed" || check.status === "unavailable" ? CommandStatus.Failed : CommandStatus.Partial),
  ]);
  if (context.signal.aborted) statuses.push(CommandStatus.Cancelled);
  return { status: aggregateCommandStatus(statuses), output: result, artifacts: context.artifacts.list() };
}
export type HealthInput = CommandInput & Omit<HealthCliOpts, Exclude<CommandHostOption, "format">>;
export const healthCommand = defineCommand<HealthInput, HealthResult, HealthPreparation>({
  name: "doctor health",
  reportName: (_input, result) => result.output ? `doctor-health-${result.output.checkedAt.replace(/[:.]/g, "-")}` : undefined,
  serialize: async (context, result) => {
    const artifacts = result.artifacts.filter(artifact => artifact.command === "health");
    return serializeEvidence(context, artifacts, new Map(artifacts.map(artifact => [artifact.id, { title: "Health", execution: { status: result.status } }])));
  },
  render: (context, result) => renderEvidence(context, result, { command: "health", title: "Health", scope: "系统体检",
    render: artifact => context.write(artifact, buildHealthHtml(context.json<HealthResult>(artifact, "diagnosis.json"))) }),
  validate: validateHealthOptions,
  prepare: async (context, input) => {
    const scope = await selectHealthScope(input.scope, isInteractive());
    if (scope === undefined) return undefined;
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.health });
    input = { ...input, scope };
    const selected = healthProviders(context.plugin, overviewServiceNames(input), healthScopes(scope));
    await context.ensureEnvironment({ kubernetes: true });
    const opts = { ...commandOptions(context), ...input };
    const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
    if (!kube) return undefined;
    return { input: opts, selected, kube, executor: createKubernetesExecutor(kube) };
  },
  run: (context, prepared) => health(prepared, context),
});
