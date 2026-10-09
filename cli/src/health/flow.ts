import type { FacetSummaryQuery } from "@compforge/doctor-plugin";
import { queryOverview, type OverviewProviderResult, type FacetSummaryQueryActions } from "../overview/query";
import type { CaseCheckResult } from "./cases";
import type { HealthProvider } from "./extensions";

export interface HealthProviderResult extends OverviewProviderResult {
  cases?: CaseCheckResult[];
  casesError?: string;
}

export interface HealthResult {
  query: FacetSummaryQuery;
  providers: HealthProviderResult[];
}

export interface HealthActions extends FacetSummaryQueryActions {
  cases(provider: HealthProvider, query: FacetSummaryQuery, checkpoint: (results: CaseCheckResult[]) => void): Promise<CaseCheckResult[]>;
  show(result: HealthResult): void;
}

/** @spec Health queries statistics and runs approved probes, never samples or invokes Collect. */
export async function runHealthSession(
  providers: readonly HealthProvider[], query: FacetSummaryQuery, actions: HealthActions,
): Promise<HealthResult> {
  const result: HealthResult = { query, providers: await queryOverview(providers, query, actions) };
  actions.show(result);
  for (const [index, provider] of providers.entries()) {
    if (actions.signal?.aborted) return result;
    if (!provider.consumers.length) continue;
    const summary = result.providers[index]!;
    try {
      summary.cases = await actions.cases(provider, query, cases => { summary.cases = cases; actions.show(result); });
    } catch (error) { summary.casesError = error instanceof Error ? error.message : String(error); }
    // Keep completed and interrupted attempts deliverable on cancellation.
    actions.show(result);
  }
  return result;
}
