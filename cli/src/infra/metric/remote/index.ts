import type { MetricDBReader, MetricDBResult } from "@compforge/harness-toolbox/metricdb";
import type { PrometheusQueryData, PrometheusRangeQueryData, PrometheusSuccessResponse } from "@compforge/prombed";
import type { MetricQuerySource } from "../model";

/** Adapt MetricDB seconds/results to the embedded source's millisecond query contract. */
export class RemoteMetricSource implements MetricQuerySource {
  constructor(private readonly source: MetricDBReader, private readonly signal?: AbortSignal) {}

  async query(expression: string, timeMs = Date.now()): Promise<PrometheusSuccessResponse<PrometheusQueryData>> {
    const result = await this.source.query(expression, timeMs / 1000, this.signal);
    this.checkResult(result, ["scalar", "vector"]);
    return { status: "success", data: result.data as PrometheusQueryData };
  }

  async queryRange(expression: string, startMs: number, endMs: number, stepMs: number): Promise<PrometheusSuccessResponse<PrometheusRangeQueryData>> {
    const result = await this.source.queryRange(expression, startMs / 1000, endMs / 1000, stepMs / 1000, this.signal);
    this.checkResult(result, ["matrix"]);
    return { status: "success", data: result.data as PrometheusRangeQueryData };
  }

  /** @why The metric chart contract has no partial-result state; warnings must not become complete measurements. */
  private checkResult(result: MetricDBResult, types: readonly string[]): void {
    if (result.isPartial === true || result.warnings.length) {
      throw new Error(`MetricDB query incomplete: ${result.warnings.join("; ") || "partial response"}`);
    }
    if (!types.includes(result.data.resultType)) throw new Error(`Unexpected MetricDB result type: ${result.data.resultType}`);
  }
}
