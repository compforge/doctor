import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { openPluginContext } from "../plugin/context";
import { parseCollectOutputFormat, runCollectCommand } from "../collect/composite";
import { terminalStdout } from "../terminal/output";
import { runOverviewSession, type OverviewProvider, type OverviewResult } from "./flow";
import { overviewWindow, selectOverviewFacet, selectOverviewWindow } from "./selection";
import { printOverview, writeOverviewReport } from "./report";

export interface OverviewCliOpts extends KubernetesCommandInput {
  since?: string;
  services?: string;
  tenantId?: string;
  facet?: string;
  collect?: boolean;
  output?: string;
  format?: string;
}

export function validateOverviewOptions(opts: OverviewCliOpts): void {
  if (opts.since) overviewWindow(opts.since);
  parseCollectOutputFormat(opts.format);
}

export async function runOverview(opts: OverviewCliOpts, plugin: PluginDefinition, context: CommandContext): Promise<number> {
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  const since = opts.since ?? await selectOverviewWindow(interactive);
  if (!since) return 130;
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
  if (!kube) return 130;
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
      collect: (bizIds) => runCollectCommand({
        ...opts, bizIds, kinds: ["data", "trace", "log"], sinceTime: query.window.from,
      }, plugin, context),
    });
  } finally {
    // The dashboard remains deliverable even if optional selection or collection fails.
    if (snapshot) writeOverviewReport(snapshot, context, reportDirectory);
  }
  for (const sample of result.samples) {
    terminalStdout.write(`[overview] ${sample.service}/${sample.facetId}/${sample.entryKey}: ${sample.bizId ?? sample.error}\n`);
  }
  return result.services.some((service) => !service.error) && result.collection !== "failed" ? 0 : 1;
}
