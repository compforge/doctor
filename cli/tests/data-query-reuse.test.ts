import { expect, test } from "bun:test";
import type { PluginContext, ServiceInspectQuery } from "@compforge/doctor-plugin";
import { inspectExtension } from "../../packages/plugin/tests/extension-fixture";
import { CommandContext } from "../src/command";
import { queryDataIdentities, type IdentityQueryContext } from "../src/collect/data/capability/query";
import { normalizeServiceInspectResult } from "../src/plugin/inspect";

const query = (value: string, maxFacts = 10): ServiceInspectQuery => ({
  identity: { kind: "biz_id", value }, results: new Map(), budget: { maxFacts, maxBytes: 10000 },
});
const context = (command: CommandContext, namespace = "test"): IdentityQueryContext => ({ command, config: {
  kube: { namespace }, profileName: "test",
}, log: () => {} });

/** @case id=identity-query-reuse,desc=`同轮查询复用与缺失 ID 补查`,expect=`相同 scope 只调用一次，目标和约束不同则独立查询` */
test("identity query reuse coalesces concurrent batches, supplements missing IDs and isolates scope", async () => {
  const command = new CommandContext({});
  const calls: string[][] = [];
  const extension = inspectExtension({ access: {}, accepts: ["biz_id"], provides: ["record"],
    inspect: async (_ctx, queries) => {
      calls.push(queries.map(q => q.identity.value));
      await Promise.resolve();
      return [...queries].reverse().map(({ identity }) => ({ identity, status: "collected", result: {
        resolution: { inputId: identity.value, resolvedAs: "task_id", identifiers: {} }, facts: [
          { factType: "record", kind: "record", schemaVersion: 1, recordKey: identity.value, record: { id: identity.value } },
        ],
      } }));
    },
  });
  const pluginContext = { signal: command.signal } as PluginContext;
  const run = (ctx: IdentityQueryContext, input: ServiceInspectQuery[]) => queryDataIdentities(ctx, "records", extension, pluginContext, input);
  try {
    const [first, second] = await Promise.all([run(context(command), [query("a"), query("b")]), run(context(command), [query("b"), query("c")])]);
    expect(calls).toEqual([["a", "b"], ["c"]]);
    expect(first.map(item => item.identity.value)).toEqual(["a", "b"]);
    expect(second.map(item => item.identity.value)).toEqual(["b", "c"]);
    await run(context(command), [query("a", 1)]);
    expect(calls).toHaveLength(2);
    await run(context(command, "another-target"), [query("a")]);
    await run(context(command), [{ ...query("a"), constraints: { timeWindow: { from: "2026-01-01T00:00:00Z" } } }]);
    await run(context(command), [{ ...query("a"), results: new Map([["upstream", []]]) }]);
    expect(calls).toHaveLength(5);
    const another = new CommandContext({});
    try { await run(context(another), [query("a")]); } finally { await another.disposeClients(); }
    expect(calls).toHaveLength(6);
  } finally { await command.disposeClients(); }
});

for (const state of ["failed", "partial", "truncated"] as const) test(`reuse retains ${state} evidence instead of silently retrying it`, async () => {
  const command = new CommandContext({});
  let calls = 0;
  const extension = inspectExtension({ access: {}, accepts: ["biz_id"], provides: ["record"], inspect: async (_ctx, queries) => {
    calls++;
    return queries.map(({ identity }) => state === "failed" ? { identity, status: "failed", reason: "database unavailable" } : {
      identity, status: "collected", result: {
        resolution: { inputId: identity.value, resolvedAs: "task_id", identifiers: {} },
        facts: [1, 2].map(n => ({ factType: "record" as const, kind: "record", schemaVersion: 1, recordKey: String(n), record: { n } })),
        ...(state === "partial" ? { sources: [{ source: "db", status: "failed" as const, reason: "denied" }] } : {}),
      },
    });
  } });
  try {
    const ctx = context(command), plugin = { signal: command.signal } as PluginContext;
    const first = await queryDataIdentities(ctx, "records", extension, plugin, [query("a", state === "truncated" ? 1 : 10)]);
    const repeated = await queryDataIdentities(ctx, "records", extension, plugin, [query("a", 20)]);
    expect(calls).toBe(1);
    expect(repeated).toEqual(first);
    if (repeated[0]!.status === "collected") {
      const bounded = normalizeServiceInspectResult({ value: repeated[0]!.result, service: "records", queryIdentity: query("a").identity, capability: extension, budget: query("a", 1).budget });
      expect(bounded.facts.length + (bounded.sources?.length ?? 0)).toBeLessThanOrEqual(1);
      expect(bounded.truncated).toBeDefined();
      if (state === "partial") expect(bounded.sources?.[0]?.status).toBe("failed");
    }
  } finally { await command.disposeClients(); }
});
