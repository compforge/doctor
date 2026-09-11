export const DEFAULT_OVERVIEW_SAMPLE_COUNT = 5;

/** CLI overrides profile; this is the hard cap for collected representative requests. */
export function overviewSampleCount(value?: number, configured?: number): number {
  const count = value ?? configured ?? DEFAULT_OVERVIEW_SAMPLE_COUNT;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("overview sample count 必须是正整数（--sample-count / overview.sample_count）");
  return count;
}

export const DEFAULT_OVERVIEW_COLLECT_CONCURRENCY = 2;

export function overviewCollectConcurrency(value?: number, configured?: number): number {
  const count = value ?? configured ?? DEFAULT_OVERVIEW_COLLECT_CONCURRENCY;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("overview collect concurrency 必须是正整数（--collect-concurrency / overview.collect_concurrency）");
  return count;
}
