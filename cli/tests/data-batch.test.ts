import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createServiceCatalog, type PluginContext, type PluginDefinition, type ServiceInspectQuery } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { runCollectData } from "../src/collect/data";

for (const ids of [["a"], ["a", "b", "missing"], ["missing"]]) test(`Data acquires and projects the complete list: ${ids}`, async () => {
  let preparations = 0;
  const batches: string[][] = [];
  const plugin: PluginDefinition = { id: "batch", version: "1", services: createServiceCatalog([{
    name: "records", workloads: [], capabilities: {}, contributions: {
      inspect: { access: {}, accepts: ["biz_id", "conversation_id"], provides: ["record"], expands: ["conversation_id"],
        resolveTarget: async () => { preparations++; return { endpoint: "test", database: "test", username: "test", credentialSource: "test" }; },
        inspect: async (_context, queries: readonly ServiceInspectQuery[]) => {
          batches.push(queries.map(query => query.identity.value));
          // Return reversed results deliberately: identity, not response position, controls attribution.
          return [...queries].reverse().map(({ identity }) => identity.value === "missing"
            ? { identity, status: "failed" as const, reason: "record unavailable" }
            : { identity, status: "collected" as const, result: {
              resolution: { inputId: identity.value, resolvedAs: identity.kind, identifiers: {} },
              facts: [{ factType: "record" as const, kind: "record", schemaVersion: 1, recordKey: identity.value, record: { id: identity.value } },
                ...(identity.kind === "biz_id" ? [{ factType: "relation" as const, kind: "conversation", schemaVersion: 1,
                  from: identity, to: { kind: "conversation_id", value: "shared" } }] : [])],
            } });
        },
      },
      detectors: [{ id: "ownership", detect: evidence => evidence.facts.filter(fact => fact.query?.kind === "biz_id" && fact.kind === "record").map(fact => ({
        id: `record-${fact.query!.value}`, kind: "record", schemaVersion: 1, severity: "info", confidence: "high",
        message: fact.query!.value, evidence: [{ factPath: fact.factPath!, role: "supporting" }],
      })) }],
    },
  }]) };
  const context = new CommandContext({});
  try {
    const result = await runCollectData({ bizIds: ids, services: "records", namespace: "test", format: "json" },
      plugin, context, { run: async () => { throw new Error("unexpected access"); }, exec: async () => { throw new Error("unexpected access"); } },
      { records: {} as PluginContext });
    expect(preparations).toBe(1);
    expect(batches).toEqual(ids.some(id => id !== "missing") ? [ids, ["shared"]] : [ids]);
    expect(result.status).toBe(ids.length > 1 ? CommandStatus.Partial : ids[0] === "missing" ? CommandStatus.Failed : CommandStatus.Ok);
    const output = result.output;
    if (!output) throw new Error("missing Data output");
    expect(output.items.map(item => [item.bizId, item.status])).toEqual(ids.map(id => [id, id === "missing" ? "failed" : "ok"]));
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
