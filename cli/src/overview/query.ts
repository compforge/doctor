import type { OverviewCostQuery, OverviewCostResult, OverviewFacetResult, OverviewQuery } from "@compforge/doctor-plugin";
import type { OverviewProvider } from "./extensions";
import { checkedCost } from "./cost";

export interface OverviewProviderResult {
  namespace: string;
  name: string;
  facets: readonly OverviewFacetResult[];
  error?: string;
  cost?: OverviewCostResult;
  costError?: string;
}

export interface OverviewQueryActions {
  summarize(provider: OverviewProvider, query: OverviewQuery): Promise<readonly OverviewFacetResult[]>;
  cost?(provider: OverviewProvider, query: OverviewCostQuery): Promise<OverviewCostResult>;
  signal?: AbortSignal;
}

function checkedFacets(provider: OverviewProvider, results: readonly OverviewFacetResult[], limit: number) {
  const remaining = new Set(provider.summarize!.facets.map(facet => facet.id));
  const facets = results.map(result => {
    if (!remaining.delete(result.facetId)) throw new Error(`未声明或重复的 Facet: ${result.facetId}`);
    const keys = new Set<string>();
    for (const entry of result.entries) {
      if (!entry.key || keys.has(entry.key)) throw new Error(`空或重复的 Entry key: ${result.facetId}/${entry.key}`);
      keys.add(entry.key);
      if (typeof entry.data !== "string" && (typeof entry.data !== "number" || !Number.isFinite(entry.data))) {
        throw new Error(`无效的 Entry data: ${result.facetId}/${entry.key}`);
      }
    }
    return { ...result, entries: result.entries.slice(0, limit),
      truncated: result.entries.length > limit ? { reason: `Core 限制为 ${limit} 个 Entry` } : result.truncated };
  });
  // A missing result is not equivalent to an empty Facet.
  if (remaining.size) throw new Error(`未返回 Facet: ${[...remaining].join(", ")}`);
  return facets;
}

/** Shared statistics only: callers own probing, sample selection and collection. */
export async function queryOverview(
  providers: readonly OverviewProvider[], query: OverviewQuery, actions: OverviewQueryActions,
): Promise<OverviewProviderResult[]> {
  const results: OverviewProviderResult[] = [];
  // Keep external-resource concurrency bounded across customer environments.
  for (const provider of providers) {
    actions.signal?.throwIfAborted();
    const summary: OverviewProviderResult = { namespace: provider.namespace, name: provider.name, facets: [] };
    results.push(summary);
    if (provider.summarize) {
      try {
        summary.facets = checkedFacets(provider, await actions.summarize(provider, query), query.maxEntries);
      } catch (error) { summary.error = error instanceof Error ? error.message : String(error); }
    }
    // Independent outcomes preserve a successful summary when duration queries fail.
    if (provider.cost) {
      actions.signal?.throwIfAborted();
      try {
        if (!actions.cost) throw new Error("Missing overview.cost executor");
        const costQuery = { ...query, maxRecords: 1000 };
        summary.cost = checkedCost(await actions.cost(provider, costQuery), costQuery);
      } catch (error) { summary.costError = error instanceof Error ? error.message : String(error); }
    }
  }
  return results;
}
