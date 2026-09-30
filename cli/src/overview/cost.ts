import type { OverviewCostQuery, OverviewCostResult } from "@compforge/doctor-plugin";

/** Validate the public aggregate contract; business intervals and statistics remain provider-owned. */
export function checkedCost(result: OverviewCostResult, query: OverviewCostQuery): OverviewCostResult {
  if (!result || typeof result.description !== "string" || !result.description.trim() || !Array.isArray(result.entries)) {
    throw new Error("overview.cost requires a description and entries");
  }
  const keys = new Set<string>();
  for (const entry of result.entries) {
    if (!entry || typeof entry.key !== "string" || !entry.key.trim() || keys.has(entry.key)
      || typeof entry.label !== "string" || !entry.label.trim()) throw new Error("Invalid or duplicate cost entry");
    keys.add(entry.key);
    if (![entry.sampleCount, entry.missingCount].every(value => Number.isSafeInteger(value) && value >= 0)
      || entry.sampleCount + entry.missingCount > query.maxRecords) throw new Error(`Invalid cost counts: ${entry.key}`);
    const d = entry.durationMs;
    if (entry.sampleCount === 0) {
      if (d !== undefined) throw new Error(`Empty cost sample has durations: ${entry.key}`);
    } else if (!d || ![d.min, d.avg, d.p50, d.p95, d.max].every(value => Number.isFinite(value) && value >= 0)
      || d.min > d.p50 || d.p50 > d.p95 || d.p95 > d.max || d.avg < d.min || d.avg > d.max) {
      throw new Error(`Invalid cost durations: ${entry.key}`);
    }
  }
  return { ...result, entries: result.entries.slice(0, query.maxEntries),
    truncated: result.entries.length > query.maxEntries
      ? { reason: [result.truncated?.reason, `Core 限制为 ${query.maxEntries} 个耗时条目`].filter(Boolean).join("；") }
      : result.truncated };
}
