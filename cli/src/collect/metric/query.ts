import type { ServiceMetricCapability, ServiceMetricQuery } from "@compforge/doctor-plugin";
import {
  prometheusDuration,
  type PrometheusQueryData,
  type PrometheusRangeQueryData,
} from "../../infra/metric";
import type {
  MetricQueryConsumer,
  MetricQueryPlan,
  MetricSeries,
} from "./model";

export function metricExpression(query: ServiceMetricQuery, watched: boolean, windowMs: number): string {
  const expression = watched ? query.range : query.instant;
  return expression.replaceAll("{{window}}", prometheusDuration(windowMs));
}

export function buildMetricQueryPlans(input: {
  service: string;
  capability: ServiceMetricCapability;
  startedAt: number;
  finishedAt: number;
  intervalMs: number;
  watched: boolean;
}): MetricQueryPlan[] {
  const durationMs = Math.max(input.finishedAt - input.startedAt, input.intervalMs);
  const rateWindowMs = Math.min(durationMs, Math.max(10_000, input.intervalMs * 2));
  const grouped = new Map<string, Omit<MetricQueryPlan, "id">>();
  const add = (
    queryKind: MetricQueryPlan["queryKind"],
    expression: string,
    consumer: MetricQueryConsumer,
  ) => {
    const key = `${queryKind}\u0000${expression}`;
    const existing = grouped.get(key);
    if (existing) existing.consumers.push(consumer);
    else grouped.set(key, { queryKind, expression, consumers: [consumer] });
  };

  for (const definition of input.capability.charts) {
    if (definition.kind === "line" && input.watched) {
      add("range", metricExpression(definition.query, true, rateWindowMs), { kind: "chart", definition });
    } else {
      add("instant", metricExpression(definition.query, input.watched, durationMs), { kind: "chart", definition });
    }
  }
  for (const definition of input.capability.detectors ?? []) {
    add("instant", metricExpression(definition.query, input.watched, durationMs), { kind: "detector", definition });
  }

  return [...grouped.values()].map((plan, index) => ({
    ...plan,
    id: `metric-query:${input.service}:${String(index + 1).padStart(2, "0")}`,
  }));
}

export function matrixMetricSeries(result: PrometheusRangeQueryData["result"]): MetricSeries[] {
  return result.map((item) => ({
    labels: item.metric,
    points: item.values
      .map(([timestamp, value]) => ({ timestamp: timestamp * 1000, value: Number(value) }))
      .filter((point) => Number.isFinite(point.value)),
  }));
}

export function instantMetricSeries(data: PrometheusQueryData, timestampMs: number): MetricSeries[] {
  if (data.resultType === "scalar") {
    const value = Number(data.result[1]);
    return Number.isFinite(value) ? [{ labels: {}, points: [{ timestamp: timestampMs, value }] }] : [];
  }
  return data.result.flatMap((item) => {
    const value = Number(item.value[1]);
    return Number.isFinite(value)
      ? [{ labels: item.metric, points: [{ timestamp: item.value[0] * 1000, value }] }]
      : [];
  });
}
