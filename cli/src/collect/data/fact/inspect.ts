import type { Inspect } from "../../inspection";
import type { DataAccessPreparation } from "../preparation";
import type { DataCommandContext } from "../context";
import type { DataFacts, DataServiceFacts } from "../model";

/** Access readiness is not proof that the subsequent query will succeed. */
export function makeDataInspect(prepared: DataAccessPreparation): Inspect<DataFacts, DataCommandContext> {
  return {
    id: "data-service-access",
    run: async ctx => {
      const services: Record<string, DataServiceFacts> = {};
      for (const { service, access } of prepared.confirmed) {
        ctx.bundle.addStep({
          id: `data-inspect-${service}`, title: `${service} Inspect access`, risk: "observe",
          status: access.status === "collected" ? "ok" : access.status,
          reason: access.status === "collected" ? undefined : access.reason,
        });
        services[service] = { access };
      }
      return { services };
    },
  };
}
