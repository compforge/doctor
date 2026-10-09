/** Duration statistics only; monetary/resource costs use separate contracts. */
export interface DurationSummaryQuery {
  /** Frozen UTC instants; providers must use the half-open interval [from, to). */
  window: { from: string; to: string };
  tenantId?: string;
  /** Maximum duration entries; providers must disclose truncation. */
  maxEntries: number;
  /** Maximum source records per provider; bound reads and disclose any truncation. */
  maxRecords: number;
}

export interface DurationEntry {
  key: string;
  label: string;
  /** Records with valid, completed intervals. Missing/invalid intervals are not zero. */
  sampleCount: number;
  missingCount: number;
  /** Milliseconds; required iff sampleCount > 0. Percentile convention belongs in description. */
  durationMs?: { min: number; avg: number; p50: number; p95: number; max: number };
}

export interface DurationSummary {
  /** Population, timestamp meanings, interval and percentile conventions. */
  description: string;
  entries: readonly DurationEntry[];
  truncated?: { reason: string };
}
