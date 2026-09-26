import type { Identity } from "./capability";

/** A named lens over notable data. The same id across providers must have the same meaning. */
export interface OverviewFacet {
  id: string;
  title: string;
  description: string;
}

/** A dynamic item within a Facet; data is presentation content, not necessarily a count. */
export interface OverviewEntry {
  key: string;
  label: string;
  data: number | string;
  unit?: string;
  canSample: boolean;
}

export interface OverviewQuery {
  /** Frozen UTC instants; providers must use the half-open interval [from, to). */
  window: { from: string; to: string };
  tenantId?: string;
  /** Maximum entries per Facet. Providers must bound queries and disclose truncation. */
  maxEntries: number;
}

export interface OverviewFacetResult {
  facetId: string;
  entries: readonly OverviewEntry[];
  /** State which timestamp and population the summary describes. */
  description: string;
  truncated?: { reason: string };
}

export interface OverviewSampleQuery extends OverviewQuery {
  facetId: string;
  entryKey: string;
  /** Positive per-Entry budget assigned by Core. Providers must not return more samples. */
  limit: number;
}

export interface OverviewSample {
  /** Existing collect input; Core retains the namespace/Facet/Entry provenance. */
  bizId: string;
  /** Record from which the representative request was selected. */
  source?: Identity;
}
