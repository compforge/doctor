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

/** Singular selection is explicit; the existing plural option remains available for comparisons. */
export function overviewServiceNames(opts: { service?: string; services?: string }): string[] | undefined {
  if (opts.service !== undefined && opts.services !== undefined) throw new Error("--service 与 --services 不能同时使用");
  const value = opts.service ?? opts.services;
  if (value === undefined) return undefined;
  const names = value.split(",").map(name => name.trim());
  if (names.some(name => !name) || (opts.service !== undefined && names.length !== 1)) {
    throw new Error("--service 需要一个 Service；多个 Service 请使用 --services，名称不能为空");
  }
  return names;
}
