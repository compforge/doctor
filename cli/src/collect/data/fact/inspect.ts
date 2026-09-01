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
        const inspect: DataServiceFacts["inspect"] = confirmed.targetFact.status === "collected"
          ? collectedFact("data.inspect-capability", "data-service-targets", { queryable: true })
          : confirmed.targetFact.status === "failed"
            ? failedFact("data.inspect-capability", "data-service-targets", confirmed.targetFact.reason)
            : unavailableFact("data.inspect-capability", "data-service-targets", confirmed.targetFact.reason);
        ctx.bundle.addStep({
          id: `data-inspect-${confirmed.service}`,
          title: `${confirmed.service} Inspect contribution`,
          risk: "observe",
          status: inspect.status === "collected" ? "ok" : inspect.status,
          reason: inspect.status === "collected" ? undefined : inspect.reason,
        });
        const target = confirmed.targetFact.status === "collected"
          ? collectedFact("data.service-target", "data-service-targets", {
              service: confirmed.targetFact.service,
              endpoint: confirmed.targetFact.endpoint,
              database: confirmed.targetFact.database,
              username: confirmed.targetFact.username,
              credentialSource: confirmed.targetFact.credentialSource,
            })
          : confirmed.targetFact.status === "failed"
            ? failedFact("data.service-target", "data-service-targets", confirmed.targetFact.reason)
            : unavailableFact("data.service-target", "data-service-targets", confirmed.targetFact.reason);
        services[confirmed.service] = { target, inspect };
      }
      return { services };
    },
  };
}
