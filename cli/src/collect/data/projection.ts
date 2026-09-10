import type { Identity } from "@compforge/doctor-plugin";
import type { DataFacts } from "./model";

const key = (identity: Identity) => JSON.stringify([identity.kind, identity.value]);

/** Follow directed relations from one root. Shared descendants never make sibling roots reachable. */
export function projectDataFacts(facts: DataFacts, bizId: string): DataFacts {
  const reachable = new Set([key({ kind: "biz_id", value: bizId })]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const query of facts.capabilityResults) {
      if (!reachable.has(key(query.identity)) || query.status !== "collected") continue;
      for (const fact of query.result.facts) {
        if (fact.factType !== "relation" || !reachable.has(key(fact.from))) continue;
        const target = key(fact.to);
        if (!reachable.has(target)) { reachable.add(target); changed = true; }
      }
    }
  }
  return { services: facts.services, capabilityResults: facts.capabilityResults.filter(query => reachable.has(key(query.identity))) };
}
