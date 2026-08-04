import {
  Prombed,
  type FetchLike,
  type IngestOptions,
  type PrombedOptions,
  type PrometheusQueryData,
  type PrometheusRangeQueryData,
  type PrometheusSuccessResponse,
  type ScrapeTarget,
} from "@compforge/prombed";
import type { MetricQuerySource } from "../model";

const MAX_SERIES = 20_000;
const MAX_RANGE_POINTS = 20_000;
const MIN_SAMPLES_PER_SERIES = 20;

export interface EmbeddedMetricTarget {
  url: string;
  labels?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  metricNames?: string[];
}

export interface EmbeddedMetricSourceOptions {
  targets?: readonly EmbeddedMetricTarget[];
  retentionMs: number;
  sampleIntervalMs: number;
  fetch?: FetchLike;
}

/** In-process scrape, short-retention storage, and PromQL query source backed by Prombed. */
export class EmbeddedMetricSource implements MetricQuerySource {
  readonly #prombed: Prombed;
  readonly #targets: ScrapeTarget[];

  constructor(options: EmbeddedMetricSourceOptions) {
    if (options.retentionMs <= 0 || options.sampleIntervalMs <= 0) {
      throw new Error("Embedded metric retentionMs 和 sampleIntervalMs 必须大于 0");
    }
    this.#targets = (options.targets ?? []).map((target) => ({
      ...target,
      labels: target.labels ? { ...target.labels } : undefined,
      headers: target.headers ? { ...target.headers } : undefined,
      metricNames: target.metricNames ? [...target.metricNames] : undefined,
    }));
    const prombedOptions: PrombedOptions = {
      retentionMs: options.retentionMs,
      maxSeries: MAX_SERIES,
      maxSamplesPerSeries: Math.max(
        MIN_SAMPLES_PER_SERIES,
        Math.ceil(options.retentionMs / options.sampleIntervalMs) + 2,
      ),
      maxRangePoints: MAX_RANGE_POINTS,
      lookbackDeltaMs: Math.max(5 * 60_000, options.sampleIntervalMs * 2),
      fetch: options.fetch,
    };
    this.#prombed = new Prombed(prombedOptions);
  }

  /** Scrape every configured target independently so one failed Service does not hide the others. */
  async scrapeOnce(): Promise<string[]> {
    const results = await Promise.allSettled(this.#targets.map((target) => this.#prombed.scrapeOnce(target)));
    return results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return [`${this.#targets[index]!.url}: ${reason}`];
    });
  }

  ingest(exposition: string, options?: IngestOptions): number {
    return this.#prombed.ingest(exposition, options);
  }

  async query(expression: string, timeMs?: number): Promise<PrometheusSuccessResponse<PrometheusQueryData>> {
    return this.#prombed.query(expression, timeMs);
  }

  async queryRange(
    expression: string,
    startMs: number,
    endMs: number,
    stepMs: number,
  ): Promise<PrometheusSuccessResponse<PrometheusRangeQueryData>> {
    return this.#prombed.queryRange(expression, startMs, endMs, stepMs);
  }
}
