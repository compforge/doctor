import { overviewProviders } from "./extensions";
import { prepareCommandRequirements } from "../command/prepare";
import { serializeEvidence } from "../collect/serialize";
import { isInteractive } from "../terminal/policy";
import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import { collectCommand, parseCollectKinds, parseCollectOutputFormat, resolveCollectKinds, type CollectOutput } from "../collect/composite";
import { CommandStatus, aggregateCommandStatus, defineCommand, type CommandContext, type CommandInput, type CommandResult } from "../command";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { openPluginContext } from "../plugin/context";
import { renderEvidence } from "../report/evidence";
import { composeReports } from "../report/model";

import { useLogger } from "../terminal/log";
import { collectOverviewSamples } from "./collect";
import { runOverviewSession, type OverviewProvider, type OverviewResult } from "./flow";
import { overviewCollectConcurrency, overviewSampleCount } from "./options";
import { buildOverviewHtml, printOverview, writeOverviewEvidence } from "./report";
import { overviewWindow, selectOverviewEntries, selectOverviewFacet, selectOverviewWindow } from "./selection";

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

async function overview(opts: OverviewCliOpts, plugin: PluginDefinition, context: CommandContext): Promise<CommandResult<OverviewOutput>> {
  const sampleCount = overviewSampleCount(opts.sampleCount, context.profile.value.overview?.sample_count);
  const concurrency = overviewCollectConcurrency(opts.collectConcurrency, context.profile.value.overview?.collect_concurrency);
  const interactive = isInteractive();
  const since = opts.since ?? await selectOverviewWindow(interactive);
  if (!since) return { status: CommandStatus.Cancelled, artifacts: [] };
  const providers = overviewProviders(plugin.services);
  const requested = opts.services === undefined ? undefined
    : plugin.services.resolveNames(opts.services.split(",").map((name) => name.trim()).filter(Boolean));
  for (const name of requested ?? []) {
    if (!providers.some((provider) => provider.name === name)) throw new Error(`Service '${name}' 未声明 overview.summarize Extension`);
  }
  const selected = requested ? providers.filter((provider) => requested.includes(provider.name)) : providers;
  if (opts.facet && !selected.some((provider) => provider.summarize.facets.some((facet) => facet.id === opts.facet))) {
    throw new Error(`未声明的 Facet: ${opts.facet}`);
  }
  const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
  if (!kube) return { status: CommandStatus.Cancelled, artifacts: [] };
  const executor = createKubernetesExecutor(kube);
  const db = context.profile.value.db;
  const invoke = async <T>(provider: OverviewProvider, extension: OverviewProvider["summarize"] | NonNullable<OverviewProvider["sample"]>, work: (managed: PluginContext) => Promise<T>): Promise<T> => {
    const managed = await openPluginContext(executor, kube.kubernetes, {
      config: context.profile.pluginConfig,
      databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined,
      service: provider.service, capability: extension,
      command: "doctor overview", authorization: context.kubernetes(executor).access,
    });
    try { return await work(managed); } finally { await managed.dispose(); }
  };
  // Freeze after target selection, before the first provider query; sampling reuses these exact instants.
  const query = { window: overviewWindow(since), tenantId: opts.tenantId, maxEntries: 100 };
  context.artifacts.setReportName(`doctor-overview-${query.window.to.replace(/[:.]/g, "-")}`);
  let collectionResult: CommandResult<CollectOutput> | undefined;
  let snapshot: OverviewResult | undefined;
  let reportDirectory: string | undefined;
  let result: OverviewResult;
  try {
    result = await runOverviewSession(selected, query, {
      signal: context.signal,
      sampleCount,
      selectEntries: (entries, count) => selectOverviewEntries(entries, count, interactive),
      summarize: (provider, input) => invoke(provider, provider.summarize, (managed) => provider.summarize.run(managed, input)),
      sample: (provider, input) => {
        const extension = provider.sample;
        if (!extension) throw new Error(`${provider.name}: missing overview.sample Extension`);
        return invoke(provider, extension, (managed) => extension.run(managed, input));
      },
      select: (facets) => selectOverviewFacet(facets, opts, interactive),
      warn: (message) => useLogger("overview").warn(`${message}`),
      show: (result) => {
        snapshot = result;
        printOverview(result);
        // Preserve the overview snapshot before optional collection; render owns reading order.
        reportDirectory = writeOverviewEvidence(result, context);
      },
      collect: async (bizIds) => {
        const kinds = await resolveCollectKinds(opts.include, interactive);
        if (!kinds) return { status: CommandStatus.Cancelled, artifacts: [] };
        collectionResult = await collectOverviewSamples(context, bizIds, {
          namespace: kube.kubernetes.namespace, tenantId: opts.tenantId,
          kinds, sinceTime: query.window.from, untilTime: query.window.to,
        }, concurrency);
        return collectionResult;
      },
    });
  } finally {
    // The dashboard remains deliverable even if optional selection or collection fails.
    if (snapshot) writeOverviewEvidence(snapshot, context, reportDirectory);
  }
  for (const sample of result.samples) {
    useLogger("overview").info(`${sample.service}/${sample.facetId}/${sample.entryKey}: ${sample.bizId ?? sample.error}`);
  }
  const statuses: CommandStatus[] = result.services.map((service) => service.error ? CommandStatus.Failed : CommandStatus.Ok);
  if (result.collection !== "not-requested" && result.collection !== "no-samples") statuses.push(result.collection);
  if (result.samples.some((sample) => sample.error)) statuses.push(CommandStatus.Failed);
  return { status: aggregateCommandStatus(statuses), output: { ...result, collectionResult }, artifacts: context.artifacts.list() };
}

export interface OverviewOutput extends OverviewResult { readonly collectionResult?: CommandResult<CollectOutput> }

export type OverviewInput = CommandInput & Omit<OverviewCliOpts, Exclude<CommandHostOption, "format">>;
export const overviewCommand = defineCommand<OverviewInput, OverviewOutput>({
  name: "doctor overview",
  serialize: async (context, result) => {
    const own = serializeEvidence(context, result.artifacts.filter(artifact => artifact.command === "overview"));
    const collected = result.output?.collectionResult;
    return { ...own, children: collected ? [await context.serialize(collectCommand, collected)] : [] };
  },
  render: async (context, result) => {
    const dashboard = await renderEvidence(context, result, {
      command: "overview", title: "Overview", scope: "概览 / 采样窗口",
      render: artifact => context.write(artifact, buildOverviewHtml(context.json<OverviewResult>(artifact, "diagnosis.json"))),
    });
    const collected = result.output?.collectionResult;
    return composeReports("doctor overview", [dashboard, ...(collected ? [await context.render(collectCommand, collected)] : [])]);
  },
  validate: validateOverviewOptions,
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.overview, environment: { kubernetes: true } });
    return input;
  },
  run: (context, input) => overview({ ...commandOptions(context), ...input }, context.plugin, context),
});
