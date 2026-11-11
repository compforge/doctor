import { COLLECT_WINDOW_KIND, type ServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import { prepareDataCommand } from "../data/context";
import { prepareDataInspection, dataOutcomes } from "../data/inspection";
import { dataProviders } from "../data/extensions";
import { dataServicesForBizQuery } from "../data/config";
import type { CollectDataCliOpts, DataFacts } from "../data/model";
import { EvidenceBundle } from "../evidence";
import { runCollect } from "../engine";
import { buildDataEvidence } from "../data/detector";

export interface LogAssociations { facts: DataFacts; gaps: readonly string[] }

/** Select only producers that can supply a declared log identity edge or window, including upstream identities. */
export function logAssociationServices(catalog: ServiceCatalog, selected: readonly string[]): string[] {
  const reachable = new Set(dataServicesForBizQuery(catalog));
  const providers = dataProviders(catalog).filter(provider => reachable.has(provider.name));
  const wanted = new Set(selected.flatMap(name => Object.entries(catalog.find(name)?.logs?.identityRelations ?? {})
    .flatMap(([from, to]) => [from, ...to])));
  const needed = new Set(providers.filter(provider => selected.includes(provider.name)
    && provider.extension.provides.includes(COLLECT_WINDOW_KIND)).map(provider => provider.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const provider of providers) {
      if (!needed.has(provider.name) && !provider.extension.expands?.some(kind => wanted.has(kind))) continue;
      needed.add(provider.name);
      for (const kind of provider.extension.accepts) {
        if (!wanted.has(kind)) { wanted.add(kind); changed = true; }
      }
    }
  }
  return providers.filter(provider => needed.has(provider.name)).map(provider => provider.name);
}

/**
 * @spec Log independently acquires association facts through shared Inspect, without invoking Data reports or detectors.
 * @link cli/docs/commands/log.md
 */
export async function collectLogAssociations(opts: CollectDataCliOpts, plugin: PluginDefinition,
  command: CommandContext, executor: Executor, directory: string, log: (line: string) => void): Promise<LogAssociations> {
  let facts: DataFacts = { services: {}, capabilityResults: [] };
  const gaps: string[] = [];
  if (!opts.bizIds?.length) return { facts, gaps };
  let inspection: Awaited<ReturnType<typeof prepareDataInspection>> | undefined;
  try {
    const services = logAssociationServices(plugin.services, opts.services ?? []);
    if (!services.length) return { facts, gaps };
    const prepared = await prepareDataCommand({ ...opts, services }, plugin.services, command, executor);
    if (!prepared) return { facts, gaps: ["关联查询准备已取消"] };
    const bundle = new EvidenceBundle(directory, dataOutcomes(prepared.providers));
    inspection = await prepareDataInspection(prepared, bundle, log);
    const collected = await runCollect({
      ctx: inspection.ctx, config: prepared.config, inspects: inspection.inspects, log, signal: command.signal,
      checkpointPartialFacts: snapshot => { facts = { ...facts, ...snapshot }; },
      planProbes: () => [], buildEvidence: buildDataEvidence, detectors: [],
    });
    facts = collected.facts;
  } catch (error) {
    if (command.signal.aborted) throw error;
    gaps.push(`关联查询未完成：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { await inspection?.close(); }
    catch (error) { gaps.push(`关联查询资源回收失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  return { facts, gaps };
}
