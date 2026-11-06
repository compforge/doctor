import { checkHealthEndpoints } from "./deps/endpoints";
import { CommandStatus, aggregateCommandStatus, defineCommand, type CommandContext, type CommandInput, type CommandResult } from "../command";
import { prepareCommandRequirements } from "../command/prepare";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { commandOptions, type CommandHostOption } from "../command/options";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { parseCollectOutputFormat } from "../collect/composite";
import { serializeEvidence } from "../collect/serialize";
import { renderEvidence } from "../report/evidence";
import { isInteractive } from "../terminal/policy";
import { resolveApprovalGate } from "../terminal/approval";
import { overviewServiceNames } from "../overview/options";
import { ServiceDependencyRuntime } from "../collect/shared/service-dependency";
import { DataSourceHealthSession } from "../datasource/health/session";
import { useLogger } from "../terminal/log";
import type { HealthProvider } from "./extensions";
import { confirmNextHealthScope, selectHealthProviders } from "./selection";
import { runHealthSession, type HealthQuery, type HealthResult } from "./flow";
import { checkServiceCases, type CaseCheckResult } from "./biz/run";
import { prepareServiceCases, type PreparedCaseCheck } from "./biz/prepare";
import { caseCheckActions, casePrepareActions } from "./biz/runtime";
import { createHealthCaseApproval } from "./biz/approval";
import { buildHealthHtml, printHealth, writeHealthEvidence } from "./report";

import { checkHealthDataSources } from "./deps";
import { healthScopes } from "./scopes";
import { checkSelfHealthProbes } from "./self/probes";
import { checkDependencyHealthProbes } from "./deps/probes";

export interface HealthCliOpts extends KubernetesCommandInput {
  scope?: string;
  bizId?: string;
  services?: readonly string[];
  tenantId?: string;
  userId?: string;
  output?: string;
  format?: string;
}

export function validateHealthOptions(opts: HealthCliOpts): void {
  healthScopes(opts.scope);
  overviewServiceNames(opts);
  parseCollectOutputFormat(opts.format);
}

interface HealthPreparation {
  input: HealthCliOpts;
  selected: readonly HealthProvider[];
  kube: NonNullable<Awaited<ReturnType<typeof resolveKubernetesCommandConfig>>>;
  executor: ReturnType<typeof createKubernetesExecutor>;
}

async function health(prepared: HealthPreparation, context: CommandContext): Promise<CommandResult<HealthResult>> {
  const { input: opts, selected, kube, executor } = prepared;
  const cases = new Map<HealthProvider, PreparedCaseCheck[]>();
  const healthSession = new DataSourceHealthSession();
  const sources = new ServiceDependencyRuntime({ plugin: context.plugin, collect: kube, executor,
    command: "doctor health", commandContext: context, index: "*",
    log: line => useLogger("health").info(line) });
  let approve: ReturnType<typeof createHealthCaseApproval> | undefined;
  let enteredScope = false;
  const query: HealthQuery = { tenantId: opts.tenantId };
  let snapshot: HealthResult | undefined;
  let reportDirectory: string | undefined;
  let result: HealthResult;
  try {
    result = await runHealthSession(selected, query, {
      signal: context.signal,
      scopes: healthScopes(opts.scope),
      enterScope: async (scope, current) => {
        if (enteredScope && isInteractive()) printHealth(current);
        if (enteredScope && !await confirmNextHealthScope(scope, isInteractive())) {
          useLogger("health").info("已结束巡检，保留已完成的检查结果");
          return false;
        }
        enteredScope = true;
        useLogger("health").info(`开始 ${scope === "business" ? "biz" : scope} 层级巡检`);
        if (scope === "business") {
          const actions = casePrepareActions(context, executor, kube.kubernetes, opts);
          for (const provider of selected) {
            if (context.signal.aborted) break;
            if (!provider.consumers.length) continue;
            cases.set(provider, await prepareServiceCases(context.plugin, provider.service, provider.consumers, opts.tenantId, actions));
          }
          approve = createHealthCaseApproval(context, kube.kubernetes.namespace, [...cases.values()].flat(),
            resolveApprovalGate({ yes: context.options.yes }));
        }
        return !context.signal.aborted;
      },
      leaveScope: scope => {
        useLogger("health").info(`${scope === "business" ? "biz" : scope} 层级完成`);
      },
      probes: (provider, scope) => scope === "self"
        ? checkSelfHealthProbes(provider, context, executor, kube.kubernetes, opts.bizId)
        : checkDependencyHealthProbes(provider, context, executor, kube.kubernetes, opts.bizId),
      endpoints: provider => checkHealthEndpoints(provider, context, executor, kube.kubernetes),
      dataSources: provider => checkHealthDataSources(provider, sources, healthSession, context.signal),
      cases: (provider, _input, checkpoint) => {
        if (!approve) throw new Error("biz 层级尚未准备 Case 检查");
        const snapshots: CaseCheckResult[] = [];
        return checkServiceCases(cases.get(provider) ?? [],
          caseCheckActions(context, executor, kube.kubernetes, reportDirectory!, check => {
            const index = snapshots.findIndex(item => item.consumeExtension === check.consumeExtension && item.bindingId === check.bindingId);
            if (index < 0) snapshots.push(check); else snapshots[index] = check;
            checkpoint(snapshots);
          }, approve));
      },
      show: current => {
        snapshot = current;
        reportDirectory = writeHealthEvidence(current, context, reportDirectory);
      },
    });
  } finally {
    try { await sources.close(); }
    catch (error) { useLogger("health").warn(`数据源清理失败：${error instanceof Error ? error.message : String(error)}`); }
    if (snapshot) {
      writeHealthEvidence(snapshot, context, reportDirectory);
      printHealth(snapshot);
    }
  }
  const statuses: CommandStatus[] = result.providers.flatMap(provider => [
    ...(provider.endpoints ?? []).map(check => check.status === "failed" || check.status === "unavailable" ? CommandStatus.Failed : CommandStatus.Ok),
    ...(provider.probes ?? []).map(check => check.status === "unavailable" ? CommandStatus.Failed
      : check.status === "partial" ? CommandStatus.Partial
      : CommandStatus.Ok),
    ...(provider.unsupported ? [CommandStatus.Failed] : []),
    ...(provider.casesError ? [CommandStatus.Failed] : []),
    ...(provider.dataSources ?? []).map(check => check.error || !check.evidence ? CommandStatus.Failed
      : check.evidence.health.status === "unavailable" ? CommandStatus.Failed
      : check.evidence.health.status === "partial" ? CommandStatus.Partial : CommandStatus.Ok),
    ...(provider.cases ?? []).map(check => check.status === "passed" ? CommandStatus.Ok
      : check.status === "cancelled" ? CommandStatus.Cancelled : CommandStatus.Failed),
  ]);
  if (context.signal.aborted) statuses.push(CommandStatus.Cancelled);
  return { status: aggregateCommandStatus(statuses), output: result, artifacts: context.artifacts.list() };
}

export type HealthInput = CommandInput & Omit<HealthCliOpts, Exclude<CommandHostOption, "format">>;
export const healthCommand = defineCommand<HealthInput, HealthResult, HealthPreparation>({
  name: "doctor health",
  reportName: (_input, result) => result.output
    ? `doctor-health-${(result.output.checkedAt ?? new Date().toISOString()).replace(/[:.]/g, "-")}` : undefined,
  serialize: async (context, result) => {
    const artifacts = result.artifacts.filter(artifact => artifact.command === "health");
    return serializeEvidence(context, artifacts, new Map(artifacts.map(artifact => [artifact.id,
      { title: "Health", execution: { status: result.status } }])));
  },
  render: (context, result) => renderEvidence(context, result, {
    command: "health", title: "Health", scope: "系统体检",
    render: artifact => context.write(artifact, buildHealthHtml(context.json<HealthResult>(artifact, "diagnosis.json"))),
  }),
  validate: validateHealthOptions,
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.health });
    const available = await selectHealthProviders(context.plugin, overviewServiceNames(input), isInteractive());
    if (!available) return undefined;
    const scopes = healthScopes(input.scope);
    const providers = available.map(provider => ({ ...provider,
      probes: provider.probes?.filter(probe => scopes.includes(probe.health!)),
      consumers: scopes.includes("business") ? provider.consumers : [],
      endpoints: scopes.includes("deps") ? provider.endpoints : undefined,
      dataSources: scopes.includes("deps") ? provider.dataSources : [],
    })).map(provider => ({ ...provider, unsupported: provider.probes?.length || provider.consumers.length || provider.dataSources?.length || provider.endpoints !== undefined
      ? undefined : `${provider.name}: 未声明 ${input.scope ?? "all"} 层级的体检能力` }));
    if (providers.every(provider => provider.unsupported)) throw new Error(providers.map(provider => provider.unsupported).join("；"));
    await context.ensureEnvironment({ kubernetes: true });
    const opts = { ...commandOptions(context), ...input };
    const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
    if (!kube) return undefined;
    const executor = createKubernetesExecutor(kube);
    return { input: opts, selected: providers, kube, executor };
  },
  run: (context, prepared) => health(prepared, context),
});
