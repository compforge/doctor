import { expect, test } from "bun:test";
import { createServiceCatalog, type Identity, type RelationFact } from "@compforge/doctor-plugin";
import { collectedFact, failedFact } from "../src/collect/protocol";
import type { DataFacts, DataInspectResult } from "../src/collect/data/model";
import { containsLogIdentity, logIdentities, logMatches } from "../src/collect/log/correlation";
import { createTraceLineCollector } from "../src/collect/log/config";
import { logService } from "./log-fixture";

const root = { kind: "biz_id", value: "input-a" };
const sandbox = { kind: "sandbox_id", value: "sandbox-a" };
const carrier = { kind: "carrier_id", value: "shared-carrier" };
const pod = { kind: "pod_name", value: "pod-a" };
const sibling = { kind: "sandbox_id", value: "sandbox-b" };
const relation = (from: Identity, to: Identity): RelationFact => ({ factType: "relation", kind: "reference", schemaVersion: 1, from, to });
const query = (id: string, identity: Identity, facts: RelationFact[], service = "api"): DataInspectResult => ({
  id, identity, service, stage: "expand",
  ...collectedFact("data.inspect-result", "test", { result: {
    resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} }, facts,
  } }),
});
const catalog = createServiceCatalog([{ ...logService(), logs: { default: true, identityRelations: {
  biz_id: ["sandbox_id"], sandbox_id: ["carrier_id"], carrier_id: ["pod_name"],
} } }, logService("other")]);

test("directed relation closure selects descendants, not siblings of shared resources or opaque IDs", () => {
  const facts: DataFacts = { services: {}, capabilityResults: [
    query("carrier", carrier, [relation(carrier, sibling), relation(carrier, pod)]),
    query("root", root, [relation(root, sandbox), relation(sandbox, carrier)]),
    query("unrelated", sibling, [relation(sibling, { kind: "carrier_id", value: "wrong-carrier" })]),
    query("other", root, [relation(root, { kind: "sandbox_id", value: "other-service" })], "other"),
    { id: "failed", identity: root, service: "api", stage: "expand", ...failedFact("data.inspect-result", "test", "unavailable") },
    { ...query("opaque", root, []), ...collectedFact("data.inspect-result", "test", { result: {
      resolution: { inputId: root.value, resolvedAs: "sandbox_id", identifiers: { sandbox_id: "opaque-id" } },
      facts: [{ factType: "value", kind: "private", schemaVersion: 1, value: { sandbox_id: "opaque-id" } }],
    } }) },
  ] };
  const matches = logIdentities(facts, root.value, catalog);
  expect(matches.map(match => match.identity)).toEqual([sandbox, carrier, pod]);
  expect(matches.find(match => match.identity.kind === "pod_name")).toMatchObject({ queryId: "carrier", factIndex: 1 });
  expect(logIdentities(facts, "input-b", catalog)).toEqual([]);
});

test("literal token OR matching is service scoped and keeps trace and related-object provenance", () => {
  const identities = [{ service: "api", identity: carrier, queryId: "root", factIndex: 1 }];
  expect(logMatches('INFO carrier_id="shared-carrier"', [], identities, "api")).toEqual([
    { kind: "related-object", identity: carrier, queryId: "root", factIndex: 1 },
  ]);
  expect(logMatches("shared-carrier", [], identities, "other")).toEqual([]);
  expect(logMatches("trace-a shared-carrier", ["trace-a"], identities, "api").map(match => match.kind)).toEqual(["trace", "related-object"]);
  for (const text of ["shared-carrier-extra", "other-shared-carrier", "shared-carrier_2", "shared-carrier1"]) {
    expect(containsLogIdentity(text, carrier.value)).toBeFalse();
  }
  expect(containsLogIdentity("shared-carrier-extra shared-carrier", carrier.value)).toBeTrue();
});

test("object-only association preserves stacks, applies content filters afterwards, never falls back unfiltered", () => {
  const collector = createTraceLineCollector([], /ERROR/, undefined, { identityValues: [carrier.value, sandbox.value], requireIdentity: true });
  collector.push("INFO shared-carrier ready");
  collector.push("ERROR unrelated failure");
  collector.push("ERROR shared-carrier-extra failure");
  collector.push("ERROR sandbox-a failed");
  collector.push("  at observer (worker.ts:1)");
  collector.push("ERROR shared-carrier failed");
  expect(collector.lines).toEqual(["ERROR sandbox-a failed", "  at observer (worker.ts:1)", "ERROR shared-carrier failed"]);
  const unresolved = createTraceLineCollector([], undefined, undefined, { requireIdentity: true });
  unresolved.push("ERROR arbitrary log");
  expect(unresolved.lines).toEqual([]);
});
