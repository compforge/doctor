import type { Identity, ServiceCatalog } from "@compforge/doctor-plugin";
import type { DataFacts } from "../data/model";

export interface LogIdentityMatch {
  service: string;
  identity: Identity;
  /** Inspect query and relation index in the attached association evidence. */
  queryId: string;
  factIndex: number;
}

export interface LogMatch {
  kind: "input" | "trace" | "related-object";
  identity: Identity;
  queryId?: string;
  factIndex?: number;
  resolution?: { service: string; resolvedAs: string; sourceId?: string };
}

/** Follow only directed, evidenced relations; a shared descendant never selects sibling roots.
 * @spec Plugin declares traversable log identity edges. Core never inspects opaque record/value payloads.
 */
export function logIdentities(facts: DataFacts, bizId: string, catalog: ServiceCatalog): LogIdentityMatch[] {
  const key = (identity: Identity) => JSON.stringify([identity.kind, identity.value]);
  const matches = new Map<string, LogIdentityMatch>();
  for (const service of catalog.services) {
    const edges = service.logs?.identityRelations;
    if (!edges) continue;
    const reachable = new Set([key({ kind: "biz_id", value: bizId })]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const query of facts.capabilityResults) {
        if (query.status !== "collected" || !reachable.has(key(query.identity))) continue;
        query.result.facts.forEach((fact, factIndex) => {
          if (fact.factType !== "relation" || !reachable.has(key(fact.from)) || !edges[fact.from.kind]?.includes(fact.to.kind)) return;
          const target = key(fact.to);
          if (!reachable.has(target)) { reachable.add(target); changed = true; }
          if (!fact.to.value.trim()) return;
          matches.set(JSON.stringify([service.name, target]), {
            service: service.name, identity: fact.to, queryId: query.id, factIndex,
          });
        });
      }
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

/** A literal key with its provenance and optional Service scope. Trace IDs are ordinary keys. */
export interface LogKey extends LogMatch { service?: string }

export function logKeys(input: { bizId?: string; keys?: readonly LogKey[]; traceIds?: readonly string[]; identities?: readonly LogIdentityMatch[] }): LogKey[] {
  const keys: LogKey[] = [
    ...(input.bizId === undefined ? [] : [{ kind: "input" as const, identity: { kind: "biz_id", value: input.bizId } }]),
    ...(input.keys ?? []),
    ...(input.traceIds ?? []).map(value => ({ kind: "trace" as const, identity: { kind: "trace_id", value } })),
    ...(input.identities ?? []).map(identity => ({ kind: "related-object" as const, ...identity })),
  ];
  const seen = new Set<string>();
  return keys.filter(key => {
    const value = JSON.stringify([key.kind, key.service, key.identity.kind, key.identity.value, key.queryId, key.factIndex, key.resolution]);
    if (!key.identity.value.trim() || seen.has(value)) return false;
    seen.add(value); return true;
  });
}

export function serviceLogKeys(keys: readonly LogKey[], service: string): LogKey[] {
  return keys.filter(key => key.service === undefined || key.service === service);
}

export function matchLogKeys(text: string, keys: readonly LogKey[], service: string): LogKey[] {
  return serviceLogKeys(keys, service).filter(key => containsLogIdentity(text, key.identity.value));
}
