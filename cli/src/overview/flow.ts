import { overviewSampleCount } from "./options";
import { CommandStatus, type CommandResult } from "../command";
import type {
  OverviewEntry, OverviewFacet, OverviewFacetResult, OverviewQuery, OverviewSample, OverviewSampleQuery,
  ServiceDefinition, ServiceOverviewCapability,
} from "@compforge/doctor-plugin";

export type OverviewProvider = ServiceDefinition & {
  capabilities: ServiceDefinition["capabilities"] & { overview: ServiceOverviewCapability };
};

export interface OverviewServiceResult {
  service: string;
  facets: readonly OverviewFacetResult[];
  error?: string;
}

export interface OverviewSampleResult {
  service: string;
  facetId: string;
  entryKey: string;
  bizId?: string;
  source?: OverviewSample["source"];
  error?: string;
}

export interface OverviewSampleAllocation {
  service: string;
  facetId: string;
  entryKey: string;
  count: number;
}

export interface OverviewResult {
  query: OverviewQuery;
  services: OverviewServiceResult[];
  sampleAllocations: OverviewSampleAllocation[];
  samples: OverviewSampleResult[];
  collectionError?: string;
  collection: "not-requested" | "no-samples" | CommandStatus;
}

export interface OverviewEntryChoice {
  service: string;
  facetId: string;
  entry: OverviewEntry;
}

export interface OverviewActions {
  sampleCount?: number;
  selectEntries?(entries: readonly OverviewEntryChoice[], defaultCount: number): Promise<readonly OverviewEntryChoice[] | undefined>;
  summarize(provider: OverviewProvider, query: OverviewQuery): Promise<readonly OverviewFacetResult[]>;
  sample(provider: OverviewProvider, query: OverviewSampleQuery): Promise<readonly OverviewSample[]>;
  /** Undefined means overview only. Even one Facet must be explicitly confirmed. */
  select(facets: readonly OverviewFacet[]): Promise<string | undefined>;
  collect(bizIds: string[]): Promise<CommandResult<unknown>>;
  signal?: AbortSignal;
  show(result: OverviewResult): void;
  warn?(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkedFacets(provider: OverviewProvider, results: readonly OverviewFacetResult[], limit: number) {
  const remaining = new Set(provider.capabilities.overview.facets.map((facet) => facet.id));
  const facets = results.map((result) => {
    if (!remaining.delete(result.facetId)) throw new Error(`未声明或重复的 Facet: ${result.facetId}`);
    const keys = new Set<string>();
    for (const entry of result.entries) {
      if (!entry.key || keys.has(entry.key)) throw new Error(`空或重复的 Entry key: ${result.facetId}/${entry.key}`);
      keys.add(entry.key);
      if (typeof entry.data !== "string" && (typeof entry.data !== "number" || !Number.isFinite(entry.data))) {
        throw new Error(`无效的 Entry data: ${result.facetId}/${entry.key}`);
      }
    }
    return {
      ...result,
      entries: result.entries.slice(0, limit),
      truncated: result.entries.length > limit ? { reason: `Core 限制为 ${limit} 个 Entry` } : result.truncated,
    };
  });
  // A missing result is not equivalent to an empty Facet.
  if (remaining.size) throw new Error(`未返回 Facet: ${[...remaining].join(", ")}`);
  return facets;
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
    service: choice.service,
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
    query, services: [], sampleAllocations: [], samples: [], collection: "not-requested",
  };
  // Sequential provider calls keep external-resource concurrency bounded across customer environments.
  for (const provider of providers) {
    actions.signal?.throwIfAborted();
    try {
      result.services.push({
        service: provider.name,
        facets: checkedFacets(provider, await actions.summarize(provider, query), query.maxEntries),
      });
    } catch (error) {
      result.services.push({ service: provider.name, facets: [], error: errorMessage(error) });
    }
  }
  actions.show(result);
  const eligible = new Map<string, OverviewFacet>();
  for (const service of result.services) {
    const provider = providers.find((item) => item.name === service.service)!;
    for (const facet of service.facets) {
      if (facet.entries.some((entry) => entry.canSample)) {
        eligible.set(facet.facetId, provider.capabilities.overview.facets.find((item) => item.id === facet.facetId)!);
      }
    }
  }
  if (!eligible.size) return result;
  const selected = await actions.select([...eligible.values()]);
  if (!selected) return result;
  if (!eligible.has(selected)) throw new Error(`Facet '${selected}' 没有可采集的 Entry`);
  // Entry data may be text, so retain dashboard/provider ordering instead of inventing a numeric ranking.
  const candidates = result.services.flatMap((service) => (
    service.facets.find((facet) => facet.facetId === selected)?.entries
      .filter((entry) => entry.canSample)
      .map((entry) => ({ service: service.service, facetId: selected, entry })) ?? []
  ));
  const count = overviewSampleCount(actions.sampleCount);
  const entries = actions.selectEntries
    ? await actions.selectEntries(candidates, count)
    : candidates;
  if (!entries?.length) return result;
  result.sampleAllocations = allocateOverviewSamples(entries, count);
  for (const allocation of result.sampleAllocations.filter((item) => item.count === 0)) {
    actions.warn?.(
      `${allocation.service}/${allocation.facetId}/${allocation.entryKey}: 配额为 0（未采集）`,
    );
  }
  for (const allocation of result.sampleAllocations) {
    if (allocation.count === 0) continue;
    actions.signal?.throwIfAborted();
    const provider = providers.find((item) => item.name === allocation.service)!;
    const source = {
      service: allocation.service, facetId: allocation.facetId, entryKey: allocation.entryKey,
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
  result.collection = "no-samples";
  if (bizIds.length) {
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
