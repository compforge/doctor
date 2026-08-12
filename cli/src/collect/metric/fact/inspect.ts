import type { Inspect } from "../../inspection";
import type { MetricCollectContext, MetricInspectionFacts } from "../model";

export function makeMetricSourceInspect(
  targetCount: number,
): Inspect<MetricInspectionFacts, MetricCollectContext> {
  return {
    id: "metric-source",
    run: async (ctx) => {
      const source = {
        status: "collected" as const,
        kind: ctx.sourceKind,
        backend: ctx.sourceKind === "remote"
          ? "Prometheus-compatible API"
          : ctx.sourceKind === "hybrid"
            ? "Prometheus-compatible API + Prombed Store sampling"
            : "Prombed",
        targetCount,
      };
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
