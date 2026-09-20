import type { Inspect } from "../../inspection";
import type { DataAccessPreparation } from "../preparation";
import type { DataCommandContext } from "../context";
import type { DataFacts, DataServiceFacts } from "../model";
import { collectedFact, failedFact, unavailableFact } from "../../protocol";

export function makeDataInspect(
  prepared: DataAccessPreparation,
): Inspect<DataFacts, DataCommandContext> {
  return {
    id: "data-service-targets",
    run: async (ctx) => {
      const services: Record<string, DataServiceFacts> = {};
      for (const confirmed of prepared.confirmed) {
        const inspect: DataServiceFacts["inspect"] = confirmed.access.status === "collected"
          ? collectedFact("data.inspect-capability", "data-service-targets", { queryable: true })
          : confirmed.access.status === "failed"
            ? failedFact("data.inspect-capability", "data-service-targets", confirmed.access.reason)
            : unavailableFact("data.inspect-capability", "data-service-targets", confirmed.access.reason);
        ctx.bundle.addStep({
          id: `data-inspect-${confirmed.service}`,
          title: `${confirmed.service} facts.inspect Extension`,
          risk: "observe",
          status: inspect.status === "collected" ? "ok" : inspect.status,
          reason: inspect.status === "collected" ? undefined : inspect.reason,
        });
        services[confirmed.service] = { inspect };
      }
      return { services };
    },
  };
}
