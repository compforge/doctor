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
import { overviewWindow, selectOverviewWindow } from "../overview/selection";
import { overviewInvoker } from "../overview/runtime";
import type { HealthProvider } from "./extensions";
import { selectHealthProviders } from "./selection";
import { runHealthSession, type HealthResult } from "./flow";
import { checkServiceCases, type CaseCheckResult } from "./cases";
import { prepareServiceCases, type PreparedCaseCheck } from "./case-prepare";
import { caseCheckActions, casePrepareActions } from "./case-runtime";
import { createHealthCaseApproval } from "./approval";
import { buildHealthHtml, printHealth, writeHealthEvidence } from "./report";

export interface HealthCliOpts extends KubernetesCommandInput {
  since?: string;
  service?: string;
  services?: string;
  tenantId?: string;
  userId?: string;
  output?: string;
  format?: string;
}

export function validateHealthOptions(opts: HealthCliOpts): void {
  overviewServiceNames(opts);
  if (opts.since) overviewWindow(opts.since);
  parseCollectOutputFormat(opts.format);
}

interface HealthPreparation {
  input: HealthCliOpts;
  selected: readonly HealthProvider[];
  cases: ReadonlyMap<HealthProvider, PreparedCaseCheck[]>;
  since: string;
  kube: NonNullable<Awaited<ReturnType<typeof resolveKubernetesCommandConfig>>>;
  executor: ReturnType<typeof createKubernetesExecutor>;
}

async function health(prepared: HealthPreparation, context: CommandContext): Promise<CommandResult<HealthResult>> {
  const { input: opts, selected, cases, since, kube, executor } = prepared;
  const invoke = overviewInvoker(context, executor, kube.kubernetes, "doctor health");
  const approve = createHealthCaseApproval(context, kube.kubernetes.namespace, [...cases.values()].flat(),
    resolveApprovalGate({ yes: context.options.yes }));
  // Historical statistics share one frozen window; probes describe this execution, not that window.
  const query = { window: overviewWindow(since), tenantId: opts.tenantId, maxEntries: 100 };
  let snapshot: HealthResult | undefined;
  let reportDirectory: string | undefined;
  let result: HealthResult;
  try {
    result = await runHealthSession(selected, query, {
      signal: context.signal,
      summarize: (provider, input) => invoke(provider, provider.summarize!, input),
      cost: (provider, input) => invoke(provider, provider.cost!, input),
      cases: (provider, _input, checkpoint) => {
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
    if (snapshot) {
      writeHealthEvidence(snapshot, context, reportDirectory);
      printHealth(snapshot);
    }
  }
  const statuses: CommandStatus[] = result.providers.flatMap((provider, index) => [
    ...(selected[index]!.summarize ? [provider.error ? CommandStatus.Failed : CommandStatus.Ok] : []),
    ...(selected[index]!.cost ? [provider.costError ? CommandStatus.Failed : CommandStatus.Ok] : []),
    ...(provider.casesError ? [CommandStatus.Failed] : []),
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
    ? `doctor-health-${result.output.query.window.to.replace(/[:.]/g, "-")}` : undefined,
  serialize: async (context, result) => {
    const artifacts = result.artifacts.filter(artifact => artifact.command === "health");
    return serializeEvidence(context, artifacts, new Map(artifacts.map(artifact => [artifact.id,
      { title: "Health", execution: { status: result.status } }])));
  },
  render: (context, result) => renderEvidence(context, result, {
    command: "health", title: "Health", scope: "体检 / 统计窗口",
    render: artifact => context.write(artifact, buildHealthHtml(context.json<HealthResult>(artifact, "diagnosis.json"))),
  }),
  validate: validateHealthOptions,
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.health });
    const providers = await selectHealthProviders(context.plugin, overviewServiceNames(input), isInteractive());
    if (!providers) return undefined;
    await context.ensureEnvironment({ kubernetes: true });
    const opts = { ...commandOptions(context), ...input };
    const since = opts.since ?? await selectOverviewWindow(isInteractive());
    if (!since) return undefined;
    const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
    if (!kube) return undefined;
    const executor = createKubernetesExecutor(kube);
    const actions = casePrepareActions(context, executor, kube.kubernetes, opts);
    const cases = new Map<HealthProvider, PreparedCaseCheck[]>();
    for (const provider of providers) {
      if (!provider.consumers.length) continue;
      cases.set(provider, await prepareServiceCases(context.plugin, provider.caseService!, provider.consumers, opts.tenantId, actions));
      if (context.signal.aborted) break;
    }
    return { input: opts, selected: providers, cases, since, kube, executor };
  },
  run: (context, prepared) => health(prepared, context),
});
