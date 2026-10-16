import type { Probe } from "../../../protocol";
import { probeUnavailable } from "../../../protocol";
import type { VdbConfig } from "../config";
import type { VdbCommandContext } from "../context";
import type { VdbInspectionFacts } from "../fact/model";
import type { VdbObservation } from "../model";
import { DataSourceHealthSession } from "../../../../datasource/health/session";

export function makeVdbProbes(): Array<Probe<VdbObservation, VdbInspectionFacts, VdbConfig, VdbCommandContext>> {
  return [{ id: "datasource-health",
    evaluate: facts => facts.access.status === "collected" ? { runnable: true } : probeUnavailable(facts.access.reason),
    async run(ctx) {
      if (!ctx.search) return [];
      const result = await new DataSourceHealthSession().probe(ctx.search, ctx.command.signal);
      for (const probe of result.probes) ctx.bundle.fill(probe.id, { status: probe.status, reason: probe.reason,
        ...(probe.raw === undefined ? {} : { output: JSON.stringify(probe.raw, null, 2), ext: "json" }) });
      return result.observations;
    },
  }];
}
export * from "../../../../datasource/opensearch/capacity";
export * from "../../../../datasource/opensearch/cluster";
