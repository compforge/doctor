import { collectOverviewSamples } from "./collect";
import { overviewSampleCount, overviewCollectConcurrency } from "./options";
import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import { defineCommand, CommandStatus, aggregateCommandStatus, type CommandInput, type CommandContext, type CommandResult } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { openPluginContext } from "../plugin/context";
import { parseCollectOutputFormat, parseCollectKinds, resolveCollectKinds } from "../collect/composite";
import { terminalStdout } from "../terminal/output";
import { runOverviewSession, type OverviewProvider, type OverviewResult } from "./flow";
import { overviewWindow, selectOverviewEntries, selectOverviewFacet, selectOverviewWindow } from "./selection";
import { printOverview, writeOverviewReport } from "./report";

export interface OverviewCliOpts extends KubernetesCommandInput {
  since?: string;
  services?: string;
  tenantId?: string;
  facet?: string;
  collect?: boolean;
  sampleCount?: number;
  collectConcurrency?: number;
  include?: string;
  output?: string;
  format?: string;
}

export function validateOverviewOptions(opts: OverviewCliOpts): void {
  if (opts.since) overviewWindow(opts.since);
  parseCollectOutputFormat(opts.format);
  parseCollectKinds(opts.include);
  overviewSampleCount(opts.sampleCount);
  overviewCollectConcurrency(opts.collectConcurrency);
}

async function overview(opts: OverviewCliOpts, plugin: PluginDefinition, context: CommandContext): Promise<CommandResult<OverviewResult>> {
  const sampleCount = overviewSampleCount(opts.sampleCount, context.profile.value.overview?.sample_count);
  const concurrency = overviewCollectConcurrency(opts.collectConcurrency, context.profile.value.overview?.collect_concurrency);
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  const since = opts.since ?? await selectOverviewWindow(interactive);
  if (!since) return { status: CommandStatus.Cancelled, artifacts: [] };
  const providers = plugin.services.servicesWith("overview");
  const requested = opts.services?.split(",").map((name) => name.trim()).filter(Boolean);
  for (const name of requested ?? []) {
    if (!providers.some((provider) => provider.name === name)) throw new Error(`Service '${name}' 未声明 overview capability`);
  }
  const selected = requested ? providers.filter((provider) => requested.includes(provider.name)) : providers;
  if (opts.facet && !selected.some((provider) => provider.capabilities.overview.facets.some((facet) => facet.id === opts.facet))) {
    throw new Error(`未声明的 Facet: ${opts.facet}`);
  }
  const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
  if (!kube) return { status: CommandStatus.Cancelled, artifacts: [] };
  const executor = createKubernetesExecutor(kube);
  const db = context.profile.value.db;
  const invoke = async <T>(provider: OverviewProvider, work: (managed: PluginContext) => Promise<T>): Promise<T> => {
    const managed = await openPluginContext(executor, kube.kubernetes, {
      env: kube.profileName, config: context.profile.pluginConfig,
      databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined,
      service: { name: provider.name }, capability: provider.capabilities.overview,
      command: "doctor overview", authorization: context.kubernetes(executor).access,
    });
    try { return await work(managed); } finally { await managed.dispose(); }
  };
  // Freeze after target selection, before the first provider query; sampling reuses these exact instants.
  const query = { window: overviewWindow(since), tenantId: opts.tenantId, maxEntries: 100 };
  context.artifacts.setReportName(`doctor-overview-${query.window.to.replace(/[:.]/g, "-")}`);
  let snapshot: OverviewResult | undefined;
  let reportDirectory: string | undefined;
  let result: OverviewResult;
  try {
    result = await runOverviewSession(selected, query, {
      signal: context.signal,
      sampleCount,
      selectEntries: (entries, count) => selectOverviewEntries(entries, count, interactive),
      summarize: (provider, input) => invoke(provider, (managed) => (
        provider.capabilities.overview.summarize(managed, input)
      )),
      sample: (provider, input) => invoke(provider, (managed) => (
        provider.capabilities.overview.sample(managed, input)
      )),
      select: (facets) => selectOverviewFacet(facets, opts, interactive),
      show: (result) => {
        snapshot = result;
        printOverview(result);
        // Register the dashboard before child artifacts so it is the first report tab.
        reportDirectory = writeOverviewReport(result, context);
      },
      collect: async (bizIds) => {
        const kinds = await resolveCollectKinds(opts.include, interactive);
        if (!kinds) return { status: CommandStatus.Cancelled, artifacts: [] };
        return collectOverviewSamples(context, bizIds, {
          namespace: kube.kubernetes.namespace, tenantId: opts.tenantId,
          kinds, sinceTime: query.window.from,
        }, concurrency);
      },
    });
  } finally {
    // The dashboard remains deliverable even if optional selection or collection fails.
    if (snapshot) writeOverviewReport(snapshot, context, reportDirectory);
  }
  for (const sample of result.samples) {
    terminalStdout.write(`[overview] ${sample.service}/${sample.facetId}/${sample.entryKey}: ${sample.bizId ?? sample.error}\n`);
  }
  const statuses: CommandStatus[] = result.services.map((service) => service.error ? CommandStatus.Failed : CommandStatus.Ok);
  if (result.collection !== "not-requested" && result.collection !== "no-samples") statuses.push(result.collection);
  if (result.samples.some((sample) => sample.error)) statuses.push(CommandStatus.Failed);
  return { status: aggregateCommandStatus(statuses), output: result, artifacts: context.artifacts.list() };
}

export type OverviewInput = CommandInput & Omit<OverviewCliOpts, Exclude<CommandHostOption, "format">>;
export const overviewCommand = defineCommand<OverviewInput, OverviewResult>({
  name: "doctor overview",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.overview,
  validate: validateOverviewOptions,
  run: (context, input) => overview({ ...commandOptions(context), ...input }, context.plugin, context),
});
