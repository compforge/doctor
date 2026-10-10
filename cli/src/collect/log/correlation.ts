import type { Identity, ServiceCatalog } from "@compforge/doctor-plugin";
import type { DataFacts } from "../data/model";

export interface LogIdentityMatch {
  service: string;
  identity: Identity;
  /** Inspect query and relation index in the attached Data evidence. */
  queryId: string;
  factIndex: number;
}

export interface LogMatch {
  kind: "trace" | "related-object";
  identity: Identity;
  queryId?: string;
  factIndex?: number;
}

/** Follow only directed, evidenced relations; a shared descendant never selects sibling roots.
 * @spec Plugin declares traversable log identity edges. Core never inspects opaque record/value payloads.
 */
export function logIdentities(facts: DataFacts, bizId: string, catalog: ServiceCatalog): LogIdentityMatch[] {
  const key = (identity: Identity) => JSON.stringify([identity.kind, identity.value]);
  const reachable = new Set([key({ kind: "biz_id", value: bizId })]);
  const matches = new Map<string, LogIdentityMatch>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const query of facts.capabilityResults) {
      if (query.status !== "collected" || !reachable.has(key(query.identity))) continue;
      const edges = catalog.find(query.service)?.logs?.identityRelations ?? {};
      query.result.facts.forEach((fact, factIndex) => {
        if (fact.factType !== "relation" || !reachable.has(key(fact.from)) || !edges[fact.from.kind]?.includes(fact.to.kind)) return;
        const target = key(fact.to);
        if (!reachable.has(target)) { reachable.add(target); changed = true; }
        if (!fact.to.value.trim()) return;
        matches.set(JSON.stringify([query.service, target]), {
          service: query.service, identity: fact.to, queryId: query.id, factIndex,
        });
      });
    }
  }
  return [...matches.values()];
}

/** Literal token matching prevents short identities from matching prefixes of other objects. */
export function containsLogIdentity(text: string, value: string): boolean {
  if (!value) return false;
  let offset = text.indexOf(value);
  const token = /[\p{L}\p{N}_-]/u;
  while (offset >= 0) {
    const before = text[offset - 1], after = text[offset + value.length];
    if ((!before || !token.test(before)) && (!after || !token.test(after))) return true;
    offset = text.indexOf(value, offset + 1);
  }
  return false;
}

export function logMatches(text: string, traceIds: readonly string[], identities: readonly LogIdentityMatch[], service: string): LogMatch[] {
  return [
    ...traceIds.filter(value => containsLogIdentity(text, value)).map(value => ({ kind: "trace" as const, identity: { kind: "trace_id", value } })),
    ...identities.filter(match => match.service === service && containsLogIdentity(text, match.identity.value))
      .map(({ identity, queryId, factIndex }) => ({ kind: "related-object" as const, identity, queryId, factIndex })),
  ];
}
