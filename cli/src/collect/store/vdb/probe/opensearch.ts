import { probeUnavailable, type Probe } from "../../../protocol";
import { isOpenSearchReadApi } from "../../../../infra/search/opensearch";
import type { VdbConfig } from "../config";
import type { VdbCommandContext } from "../context";
import type { VdbInspectionFacts } from "../fact/model";
import type { VdbObservation } from "../model";

export interface VdbOpenSearchProbeSpec {
  id: string;
  outcome: string;
  path: string;
  query?: Record<string, unknown>;
  parse(raw: unknown): VdbObservation;
}

export function makeOpenSearchProbe(
  spec: VdbOpenSearchProbeSpec,
): Probe<VdbObservation, VdbInspectionFacts, VdbConfig, VdbCommandContext> {
  return {
    id: spec.id,
    evaluate: (facts) => facts.access.status === "collected"
      ? { runnable: true }
      : probeUnavailable(facts.access.reason),
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill(spec.outcome, { status: "unavailable", reason });
    },
    run: async (ctx) => {
      if (!ctx.search || !isOpenSearchReadApi(ctx.search)) {
        ctx.bundle.fill(spec.outcome, {
          status: "unavailable",
          reason: "SearchEngine 不支持只读 cluster API",
        });
        return [];
      }
      try {
        const raw = await ctx.search.request(spec.path, spec.query);
        ctx.bundle.fill(spec.outcome, {
          status: "ok",
          output: `${JSON.stringify(raw, null, 2)}\n`,
          ext: "json",
        });
        return [spec.parse(raw)];
      } catch (error) {
        ctx.bundle.fill(spec.outcome, {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  };
}
