import { queryOverview, type OverviewProviderResult, type OverviewQueryActions } from "./query";
import { overviewSampleCount } from "./options";
import { CommandStatus, type CommandResult } from "../command";
import type {
  OverviewEntry, OverviewFacet, OverviewQuery, OverviewSample, OverviewSampleQuery,
} from "@compforge/doctor-plugin";

import type { OverviewProvider } from "./extensions";
export type { OverviewProvider } from "./extensions";

export type { OverviewProviderResult } from "./query";

export interface OverviewSampleResult {
  namespace: string;
  facetId: string;
  entryKey: string;
  bizId?: string;
  source?: OverviewSample["source"];
  error?: string;
}

export interface OverviewSampleAllocation {
  namespace: string;
  facetId: string;
  entryKey: string;
  count: number;
}

export interface OverviewResult {
  query: OverviewQuery;
  providers: OverviewProviderResult[];
  sampleAllocations: OverviewSampleAllocation[];
  samples: OverviewSampleResult[];
  collectionError?: string;
  collection: "not-requested" | "no-samples" | CommandStatus;
}

export interface OverviewEntryChoice {
  namespace: string;
  facetId: string;
  entry: OverviewEntry;
}

export interface OverviewActions extends Omit<OverviewQueryActions, "cost"> {
  sampleCount?: number;
  selectEntries?(entries: readonly OverviewEntryChoice[], defaultCount: number): Promise<readonly OverviewEntryChoice[] | undefined>;
  sample(provider: OverviewProvider, query: OverviewSampleQuery): Promise<readonly OverviewSample[]>;
  /** Undefined means statistics only. Selecting a Facet permits lookup, not collection. */
  select(facets: readonly OverviewFacet[]): Promise<string | undefined>;
  collect(bizIds: string[]): Promise<CommandResult<unknown>>;
  confirmCollect(bizIds: readonly string[]): Promise<boolean>;
  show(result: OverviewResult): void;
  warn?(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Split one hard sample budget as evenly as possible while preserving dashboard order. */
export function allocateOverviewSamples(
  entries: readonly OverviewEntryChoice[], sampleCount: number,
): OverviewSampleAllocation[] {
  const budget = overviewSampleCount(sampleCount);
  if (!entries.length) return [];
  const base = Math.floor(budget / entries.length);
  const remainder = budget % entries.length;
  return entries.map((choice, index) => ({
    namespace: choice.namespace,
    facetId: choice.facetId,
    entryKey: choice.entry.key,
    count: base + (index < remainder ? 1 : 0),
  }));
}

/** Core owns ordering, consent, provenance and deduplication; providers own matching semantics. */
export async function runOverviewSession(
  providers: readonly OverviewProvider[], query: OverviewQuery, actions: OverviewActions,
): Promise<OverviewResult> {
  const result: OverviewResult = {
    query,
    providers: (await queryOverview(providers, query, actions)).map(summary => ({
      ...summary,
      // Validate complete provider output first, then project only entries useful for object selection.
      // Empty/truncated facets retain query coverage; complete display-only facets belong to Health.
      facets: summary.facets.flatMap(facet => {
        const entries = facet.entries.filter(entry => entry.canSample);
        return entries.length || !facet.entries.length || facet.truncated ? [{ ...facet, entries }] : [];
      }),
    })),
    sampleAllocations: [], samples: [], collection: "not-requested",
  };
  // Checkpoint before optional lookup; declining collection must retain the queried samples.
  actions.show(result);
  const eligible = new Map<string, OverviewFacet>();
  for (const summary of result.providers) {
    const provider = providers.find((item) => item.namespace === summary.namespace)!;
    for (const facet of provider.sample ? summary.facets : []) {
      if (facet.entries.some((entry) => entry.canSample)) {
        eligible.set(facet.facetId, provider.summarize!.facets.find((item) => item.id === facet.facetId)!);
      }
    }
  }
  if (!eligible.size) return result;
  const selected = await actions.select([...eligible.values()]);
  if (!selected) return result;
  if (!eligible.has(selected)) throw new Error(`Facet '${selected}' 没有可查询样本的 Entry`);
  // Entry data may be text, so retain dashboard/provider ordering instead of inventing a numeric ranking.
  const candidates = result.providers.flatMap((summary) => (
    (providers.find(provider => provider.namespace === summary.namespace)?.sample
      ? summary.facets.find((facet) => facet.facetId === selected)?.entries : undefined)
      ?.filter((entry) => entry.canSample)
      .map((entry) => ({ namespace: summary.namespace, facetId: selected, entry })) ?? []
  ));
  const count = overviewSampleCount(actions.sampleCount);
  const entries = actions.selectEntries
    ? await actions.selectEntries(candidates, count)
    : candidates;
  if (!entries?.length) return result;
  result.sampleAllocations = allocateOverviewSamples(entries, count);
  for (const allocation of result.sampleAllocations.filter((item) => item.count === 0)) {
    actions.warn?.(
      `${allocation.namespace}/${allocation.facetId}/${allocation.entryKey}: 配额为 0（未查询）`,
    );
  }
  for (const allocation of result.sampleAllocations) {
    if (allocation.count === 0) continue;
    actions.signal?.throwIfAborted();
    const provider = providers.find((item) => item.namespace === allocation.namespace)!;
    const source = {
      namespace: allocation.namespace, facetId: allocation.facetId, entryKey: allocation.entryKey,
    };
    try {
      const samples = await actions.sample(provider, {
        ...query, facetId: allocation.facetId, entryKey: allocation.entryKey, limit: allocation.count,
      });
      if (!Array.isArray(samples)) throw new Error("Overview provider 未返回样本数组");
      if (samples.length > allocation.count) {
        throw new Error(`Overview provider 返回 ${samples.length} 个样本，超过分配配额 ${allocation.count}`);
      }
      if (!samples.length) {
        result.samples.push({ ...source, error: "没有可用样本（数据可能已变化）" });
      }
      for (const sample of samples) {
        result.samples.push(sample.bizId.trim()
          ? { ...source, bizId: sample.bizId.trim(), source: sample.source }
          : { ...source, source: sample.source, error: "Overview provider 返回了空 biz-id" });
      }
    } catch (error) {
      result.samples.push({ ...source, error: errorMessage(error) });
    }
  }
  // Provider validation and this final slice jointly keep collection within the user-visible hard budget.
  const bizIds = [...new Set(result.samples.flatMap((sample) => sample.bizId ? [sample.bizId] : []))].slice(0, count);
  actions.show(result);
  if (!bizIds.length) {
    result.collection = "no-samples";
    return result;
  }
  actions.signal?.throwIfAborted();
  if (await actions.confirmCollect(bizIds)) {
    try {
      const collected = await actions.collect(bizIds);
      result.collection = collected.status;
      if ("reason" in collected) result.collectionError = collected.reason;
    } catch (error) {
      result.collection = actions.signal?.aborted ? CommandStatus.Cancelled : CommandStatus.Failed;
      result.collectionError = errorMessage(error);
    }
  }
  return result;
}
