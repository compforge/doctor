import type { Inspect } from "../../inspection";
import type { DataAccessPreparation } from "../preparation";
import type { DataCommandContext } from "../context";
import type { DataInspectionFacts, DataServiceFacts } from "../model";

export function makeDataInspect(
  prepared: DataAccessPreparation,
): Inspect<DataInspectionFacts, DataCommandContext> {
  return {
    id: "data-service-targets",
    run: async (ctx) => {
      const services: Record<string, DataServiceFacts> = {};
      for (const confirmed of prepared.confirmed) {
        const capability: DataServiceFacts["capability"] = confirmed.targetFact.status === "collected"
          ? { status: "collected", queryable: true }
          : { status: confirmed.targetFact.status, reason: confirmed.targetFact.reason };
        ctx.bundle.addStep({
          id: `data-capability-${confirmed.service}`,
          title: `${confirmed.service} data capability`,
          risk: "observe",
          status: capability.status === "collected" ? "ok" : capability.status,
          reason: capability.status === "collected" ? undefined : capability.reason,
        });
        services[confirmed.service] = { target: confirmed.targetFact, capability };
      }
      return { services };
    },
  };
}
