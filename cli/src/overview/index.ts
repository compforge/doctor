import { overviewInvoker } from "./runtime";
import { overviewProviders } from "./extensions";
import { prepareCommandRequirements } from "../command/prepare";
import { serializeEvidence } from "../collect/serialize";
import { isInteractive } from "../terminal/policy";
import { collectCommand, parseCollectKinds, parseCollectOutputFormat, resolveCollectKinds, type CollectOutput } from "../collect/composite";
import { CommandStatus, aggregateCommandStatus, defineCommand, type CommandContext, type CommandInput, type CommandResult } from "../command";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { renderEvidence } from "../report/evidence";
import { composeReports } from "../report/model";

import { useLogger } from "../terminal/log";
import { collectOverviewSamples } from "./collect";
import { runOverviewSession, type OverviewProvider, type OverviewResult } from "./flow";
import { overviewCollectConcurrency, overviewSampleCount, overviewServiceNames } from "./options";
import { buildOverviewHtml, printOverview, writeOverviewEvidence } from "./report";
import { confirmOverviewCollection, overviewWindow, selectOverviewEntries, selectOverviewFacet, selectOverviewWindow } from "./selection";

export interface SampleCliOpts extends KubernetesCommandInput {
  since?: string;
  service?: string;
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

export function validateSampleOptions(opts: SampleCliOpts): void {
  overviewServiceNames(opts);
  if (opts.since) overviewWindow(opts.since);
  parseCollectOutputFormat(opts.format);
  parseCollectKinds(opts.include);
  overviewSampleCount(opts.sampleCount);
  overviewCollectConcurrency(opts.collectConcurrency);
}

async function sample(opts: SampleCliOpts, selected: readonly OverviewProvider[], context: CommandContext): Promise<CommandResult<SampleOutput>> {
  // Keep persisted profile keys independent of the user-facing command name.
  const sampleCount = overviewSampleCount(opts.sampleCount, context.profile.value.overview?.sample_count);
  const concurrency = overviewCollectConcurrency(opts.collectConcurrency, context.profile.value.overview?.collect_concurrency);
  const interactive = isInteractive();
  const since = opts.since ?? await selectOverviewWindow(interactive);
  if (!since) return { status: CommandStatus.Cancelled, artifacts: [] };
  const kube = await resolveKubernetesCommandConfig(opts, undefined, context);
  if (!kube) return { status: CommandStatus.Cancelled, artifacts: [] };
  const executor = createKubernetesExecutor(kube);
  const invoke = overviewInvoker(context, executor, kube.kubernetes, "doctor sample");
  // Freeze after target selection, before the first provider query; sampling reuses these exact instants.
  const query = { window: overviewWindow(since), tenantId: opts.tenantId, maxEntries: 100 };
  let collectionResult: CommandResult<CollectOutput> | undefined;
  let snapshot: OverviewResult | undefined;
  let samplesShown = false;
  let reportDirectory: string | undefined;
  let result: OverviewResult;
  try {
    result = await runOverviewSession(selected, query, {
      signal: context.signal,
      sampleCount,
      selectEntries: (entries, count) => selectOverviewEntries(entries, count, interactive),
      summarize: (provider, input) => invoke(provider, provider.summarize!, input),
      sample: (provider, input) => {
        const extension = provider.sample;
        if (!extension) throw new Error(`${provider.name}: missing overview.sample Extension`);
        return invoke(provider, extension, input);
      },
      select: (facets) => selectOverviewFacet(facets, opts, interactive),
      confirmCollect: (bizIds) => confirmOverviewCollection(bizIds, opts.collect, interactive),
      warn: (message) => useLogger("sample").warn(`${message}`),
      show: (result) => {
        if (!snapshot) printOverview(result);
        if (result.samples.length && !samplesShown) {
          for (const sample of result.samples) useLogger("sample").info(`${sample.namespace}/${sample.facetId}/${sample.entryKey}: ${sample.bizId ?? sample.error}`);
          samplesShown = true;
        }
        snapshot = result;
        // Preserve the overview snapshot before optional collection; render owns reading order.
        reportDirectory = writeOverviewEvidence(result, context, reportDirectory);
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
  const statuses: CommandStatus[] = result.providers.flatMap((provider, index) => [
    ...(selected[index]!.summarize ? [provider.error ? CommandStatus.Failed : CommandStatus.Ok] : []),
  ]);
  if (result.collection !== "not-requested" && result.collection !== "no-samples") statuses.push(result.collection);
  if (result.samples.some((sample) => sample.error)) statuses.push(CommandStatus.Failed);
  return { status: aggregateCommandStatus(statuses), output: { ...result, collectionResult }, artifacts: context.artifacts.list() };
}

export interface SampleOutput extends OverviewResult { readonly collectionResult?: CommandResult<CollectOutput> }

export type SampleInput = CommandInput & Omit<SampleCliOpts, Exclude<CommandHostOption, "format">>;
export const sampleCommand = defineCommand<SampleInput, SampleOutput, { input: SampleInput; providers: OverviewProvider[] }>({
  name: "doctor sample",
  reportName: (_input, result) => result.output
    ? `doctor-sample-${result.output.query.window.to.replace(/[:.]/g, "-")}` : undefined,
  serialize: async (context, result) => {
    const artifacts = result.artifacts.filter(artifact => artifact.command === "sample");
    const own = serializeEvidence(context, artifacts, new Map(artifacts.map(artifact => [artifact.id,
      { title: "Sample", execution: { status: result.status } }])));
    const collected = result.output?.collectionResult;
    return { ...own, children: collected ? [await context.serialize(collectCommand, collected)] : [] };
  },
  render: async (context, result) => {
    const dashboard = await renderEvidence(context, result, {
      command: "sample", title: "Sample", scope: "采样窗口",
      render: artifact => context.write(artifact, buildOverviewHtml(context.json<OverviewResult>(artifact, "diagnosis.json"))),
    });
    const collected = result.output?.collectionResult;
    return composeReports("doctor sample", [dashboard, ...(collected ? [await context.render(collectCommand, collected)] : [])]);
  },
  validate: validateSampleOptions,
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.sample });
    const providers = overviewProviders(context.plugin, overviewServiceNames(input));
    if (input.facet && !providers.some(provider => provider.summarize?.facets.some(facet => facet.id === input.facet))) {
      throw new Error(`未声明的 Facet: ${input.facet}`);
    }
    // Resolve ownership and data targets before touching the environment or asking for access.
    await context.ensureEnvironment({ kubernetes: true });
    return { input, providers };
  },
  run: (context, { input, providers }) => sample({ ...commandOptions(context), ...input }, providers, context),
});
