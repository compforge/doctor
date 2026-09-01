import type { Inspect } from "../../inspection";
import type { DataAccessPreparation } from "../preparation";
import type { DataCommandContext } from "../context";
import type { DataFacts, DataServiceFacts } from "../model";

export function makeDataInspect(
  prepared: DataAccessPreparation,
): Inspect<DataFacts, DataCommandContext> {
  return {
    id: "data-service-targets",
    run: async (ctx) => {
      const services: Record<string, DataServiceFacts> = {};
      for (const confirmed of prepared.confirmed) {
        const inspect: DataServiceFacts["inspect"] = confirmed.targetFact.status === "collected"
          ? { status: "collected", queryable: true }
          : { status: confirmed.targetFact.status, reason: confirmed.targetFact.reason };
        ctx.bundle.addStep({
          id: `data-inspect-${confirmed.service}`,
          title: `${confirmed.service} Inspect contribution`,
          risk: "observe",
          status: inspect.status === "collected" ? "ok" : inspect.status,
          reason: inspect.status === "collected" ? undefined : inspect.reason,
        });
        services[confirmed.service] = { target: confirmed.targetFact, inspect };
      }
      return { services };
    },
  };
}
