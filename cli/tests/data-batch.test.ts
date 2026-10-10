import { inspectExtension } from "../../packages/plugin/tests/extension-fixture";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createServiceCatalog, type ServiceInspectSource, type PluginContext, type PluginDefinition, type ServiceInspectQuery } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { projectDataServiceEvidence } from "../src/collect/data/detector";
import { prepareDataCommand, runCollectData } from "../src/collect/data";

for (const ids of [["a"], ["a", "b", "missing"], ["missing"], ["partial"]]) test(`Data acquires and projects the complete list: ${ids}`, async () => {
  const batches: string[][] = [];
  const unavailable: ServiceInspectSource = { source: "db/records", status: "failed", reason: "denied", errorKind: "permission_denied" };
  const plugin: PluginDefinition = {
    id: "batch", version: "1", services: createServiceCatalog([{
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: "records",
      workloads: [],
      detectors: [{
        id: "ownership", detect: evidence => evidence.facts.filter(fact => fact.query?.kind === "biz_id" && fact.kind === "record").map(fact => ({
          id: `record-${fact.query!.value}`, kind: "record", schemaVersion: 1, severity: "info", confidence: "high",
          message: fact.query!.value, evidence: [{ factPath: fact.factPath!, role: "supporting" }],
        }))
      }],
      extensions: [inspectExtension({
        access: {}, accepts: ["biz_id", "conversation_id"], provides: ["record"], expands: ["conversation_id"],
        inspect: async (_context, queries: readonly ServiceInspectQuery[]) => {
          for (const query of queries) expect(query.constraints?.timeWindow).toEqual({ from: "2026-10-10T09:00:00Z", to: "2026-10-10T10:00:00Z" });
          batches.push(queries.map(query => query.identity.value));
          // Return reversed results deliberately: identity, not response position, controls attribution.
          return [...queries].reverse().map(({ identity }) => identity.value === "missing"
            ? { identity, status: "failed" as const, reason: "record unavailable", sources: [unavailable] }
            : {
              identity, status: "collected" as const, result: {
                resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} },
                ...(identity.value === "partial" ? { sources: [unavailable] } : {}),
                facts: [{ factType: "record" as const, kind: "record", schemaVersion: 1, recordKey: identity.value, record: { id: identity.value } },
                ...(identity.kind === "biz_id" ? [{
                  factType: "relation" as const, kind: "conversation", schemaVersion: 1,
                  from: identity, to: { kind: "conversation_id", value: "shared" }
                }] : [])],
              }
            });
        },
      })]
    }])
  };
  const context = new CommandContext({});
  try {
    const prepared = await prepareDataCommand({ bizIds: ids, services: "records", namespace: "test", format: "json", sinceTime: "2026-10-10T09:00:00Z", untilTime: "2026-10-10T10:00:00Z" },
      plugin.services, context, { run: async () => { throw new Error("unexpected access"); }, exec: async () => { throw new Error("unexpected access"); } });
    expect(prepared).toBeDefined();
    const result = await runCollectData(prepared!, plugin, { records: { signal: new AbortController().signal } as PluginContext });
    expect(batches).toEqual(ids.some(id => id !== "missing") ? [ids, ["shared"]] : [ids]);
    expect(result.status).toBe(ids.length > 1 ? CommandStatus.Partial : ids[0] === "missing" ? CommandStatus.Failed : ids[0] === "partial" ? CommandStatus.Partial : CommandStatus.Ok);
    const output = result.output;
    if (!output) throw new Error("missing Data output");
    expect(output.items.map(item => [item.bizId, item.status])).toEqual(ids.map(id => [id, id === "missing" ? "failed" : id === "partial" ? "partial" : "ok"]));
    for (const item of output.items.filter(item => ["partial", "missing"].includes(item.bizId))) {
      expect(item.diagnosis).toBeDefined();
      const projected = projectDataServiceEvidence(item.diagnosis!.evidence, "batch");
      expect(projected.sources?.some(source => source.result.status === "failed" && source.result.errorKind === "permission_denied")).toBe(true);
      expect(item.diagnosis!.coverage[0]?.missingEvidence.join()).toContain("db/records 查询失败");
    }
    for (const item of output.items.filter(item => item.status === CommandStatus.Ok)) {
      expect(item.diagnosis!.evidence.facts.capabilityResults.map(query => query.identity.value)).toEqual([item.bizId, "shared"]);
      expect(item.diagnosis!.findings.every(finding => finding.message === item.bizId)).toBeTrue();
      expect(item.artifacts).toHaveLength(1);
    }
  } finally {
    for (const artifact of context.artifacts.list()) rmSync(dirname(artifact.path), { recursive: true, force: true });
    await context.disposeClients();
  }
});
