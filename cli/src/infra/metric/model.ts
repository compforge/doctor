import type {
  PrometheusQueryData,
  PrometheusRangeQueryData,
  PrometheusSuccessResponse,
} from "@compforge/prombed";

export type {
  PrometheusQueryData,
  PrometheusRangeQueryData,
  PrometheusSuccessResponse,
};

/** Stable query boundary shared by remote Prometheus and embedded Prombed. */
export interface MetricQuerySource {
  query(expression: string, timeMs?: number): Promise<PrometheusSuccessResponse<PrometheusQueryData>>;
  queryRange(
    expression: string,
    startMs: number,
    endMs: number,
    stepMs: number,
  ): Promise<PrometheusSuccessResponse<PrometheusRangeQueryData>>;
}
