import type { Inspect } from "../../inspection";
import type { MetricCommandContext, MetricInspectionFacts } from "../model";
import { collectedFact } from "../../protocol";

export function makeMetricSourceInspect(
  targetCount: number,
): Inspect<MetricInspectionFacts, MetricCommandContext> {
  return {
    id: "metric-source",
    run: async (ctx) => {
      const source = collectedFact("metric.source", "metric-source", {
        sourceKind: ctx.sourceKind,
        backend: ctx.sourceKind === "remote"
          ? "Prometheus-compatible API"
          : ctx.sourceKind === "hybrid"
            ? "Prometheus-compatible API + Prombed Store sampling"
            : "Prombed",
        targetCount,
      });
      ctx.bundle.addStep({
        id: "metric-source",
        title: "Metric 查询数据源",
        risk: "observe",
        status: "ok",
        output: `${JSON.stringify(source, null, 2)}\n`,
        ext: "json",
      });
      return { source };
    },
  };
}
