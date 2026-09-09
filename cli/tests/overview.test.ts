import { CommandStatus, commandOutcome } from "../src/command";
import { expect, mock, test } from "bun:test";
import { DOCTOR_PLUGIN_API_VERSION, createServiceCatalog, type OverviewFacetResult, type OverviewQuery } from "@compforge/doctor-plugin";
import { runOverviewSession, type OverviewActions, type OverviewProvider } from "../src/overview/flow";
import { overviewWindow, selectOverviewFacet } from "../src/overview/selection";
import type { promptListedChoice } from "../src/terminal/selection";

const facet = { id: "errors", title: "Errors", description: "Recorded errors" };
const query: OverviewQuery = {
  window: overviewWindow("1h", new Date("2026-09-09T10:00:00Z")), tenantId: "tenant-1", maxEntries: 2,
};
function provider(name: string): OverviewProvider {
  return { name, workloads: [], capabilities: { overview: {
    access: {}, facets: [facet], summarize: async () => [], sample: async () => undefined,
  } } };
}
const summary: OverviewFacetResult[] = [{ facetId: "errors", description: "created_at", entries: [
  { key: "E1", label: "E1", data: 8, unit: "requests", canSample: true },
  { key: "E2", label: "E2", data: "upstream unavailable", canSample: true },
] }];
function actions(overrides: Partial<OverviewActions> = {}): OverviewActions {
  return { summarize: async () => summary, sample: async () => ({ bizId: "trace-1" }),
    select: async () => undefined, collect: async () => commandOutcome(0), show: () => {}, ...overrides };
}

test("overview shows text and numeric entries without sampling on decline", async () => {
  const sample = mock(async () => ({ bizId: "trace-1" }));
  const collect = mock(async () => commandOutcome(0));
  const order: string[] = [];
  const result = await runOverviewSession([provider("chat")], query, actions({ sample, collect,
    show: () => { order.push("show"); }, select: async () => { order.push("confirm"); return undefined; },
  }));
  expect(order).toEqual(["show", "confirm"]);
  expect(sample).not.toHaveBeenCalled();
  expect(collect).not.toHaveBeenCalled();
  expect(result.services[0]?.facets[0]?.entries[1]?.data).toBe("upstream unavailable");
  expect(result.collection).toBe("not-requested");
});

test("one sample per eligible entry retains provenance and deduplicates collect IDs across services", async () => {
  const sampleQueries: unknown[] = [];
  const batches: string[][] = [];
  const result = await runOverviewSession([provider("chat"), provider("plan")], query, actions({
    select: async (facets) => { expect(facets).toEqual([facet]); return "errors"; },
    sample: async (_provider, input) => { sampleQueries.push(input); return { bizId: "trace-1", source: { kind: "message_id", value: "m1" } }; },
    collect: async (ids) => { batches.push(ids); return commandOutcome(0); },
  }));
  expect(sampleQueries).toHaveLength(4);
  expect(sampleQueries[0]).toEqual({ ...query, facetId: "errors", entryKey: "E1" });
  expect(batches).toEqual([["trace-1"]]);
  expect(result.samples.map((item) => item.service)).toEqual(["chat", "chat", "plan", "plan"]);
  expect(result.samples[0]?.source?.value).toBe("m1");
});

test("provider failures and disappeared samples are visible while other services remain usable", async () => {
  const result = await runOverviewSession([provider("down"), provider("chat")], query, actions({
    summarize: async (service) => { if (service.name === "down") throw new Error("DB timeout"); return summary; },
    select: async () => "errors",
    sample: async (_service, input) => { if (input.entryKey === "E1") throw new Error("sample timeout"); return undefined; },
  }));
  expect(result.services[0]?.error).toBe("DB timeout");
  expect(result.services[0]?.facets).toEqual([]);
  expect(result.samples[0]?.error).toBe("sample timeout");
  expect(result.samples[1]?.error).toContain("没有可用样本");
  expect(result.collection).toBe("no-samples");
});

test("empty and non-sampleable facets never offer collection; missing results are failures", async () => {
  const select = mock(async () => "errors");
  const result = await runOverviewSession([provider("chat"), provider("empty")], query, actions({
    summarize: async (service) => service.name === "empty" ? [] : [{ ...summary[0]!, entries: [{ key: "status", label: "Status", data: "healthy", canSample: false }] }],
    select,
  }));
  expect(select).not.toHaveBeenCalled();
  expect(result.services[1]?.error).toContain("未返回 Facet");
});

test("Core bounds entry results and reports truncation", async () => {
  const result = await runOverviewSession([provider("chat")], { ...query, maxEntries: 1 }, actions());
  expect(result.services[0]?.facets[0]?.entries).toHaveLength(1);
  expect(result.services[0]?.facets[0]?.truncated?.reason).toContain("1");
});

test("duplicate keys cannot ambiguously associate an entry with its sample", async () => {
  const result = await runOverviewSession([provider("chat")], query, actions({
    summarize: async () => [{ ...summary[0]!, entries: [summary[0]!.entries[0]!, summary[0]!.entries[0]!] }],
  }));
  expect(result.services[0]?.error).toContain("重复的 Entry");
});

test("collection errors retain the dashboard and samples", async () => {
  const result = await runOverviewSession([provider("chat")], query, actions({
    select: async () => "errors", collect: async () => { throw new Error("collect unavailable"); },
  }));
  expect(result.collection).toBe(CommandStatus.Failed);
  expect(result.collectionError).toBe("collect unavailable");
  expect(result.samples).toHaveLength(2);
});

test("single facet skips selection but still asks confirmation with default No", async () => {
  const questions: string[] = [];
  const prompt: typeof promptListedChoice = async (input) => { questions.push(input.question); return input.emptyValue; };
  expect(await selectOverviewFacet([facet], {}, true, prompt)).toBeUndefined();
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain("[y/N]");
});

test("noninteractive overview is read only; explicit collection needs an unambiguous facet", async () => {
  const facets = [facet, { ...facet, id: "slow" }];
  expect(await selectOverviewFacet(facets, { facet: "errors" }, false)).toBeUndefined();
  expect(await selectOverviewFacet([facet], { collect: true }, false)).toBe("errors");
  expect(await selectOverviewFacet(facets, { collect: true, facet: "slow" }, false)).toBe("slow");
  await expect(selectOverviewFacet(facets, { collect: true }, false)).rejects.toThrow("--facet");
});

test("time window presets freeze absolute instants and reject invalid durations", () => {
  expect(query.window).toEqual({ from: "2026-09-09T09:00:00.000Z", to: "2026-09-09T10:00:00.000Z" });
  expect(overviewWindow("3d", new Date(query.window.to)).from).toBe("2026-09-06T10:00:00.000Z");
  expect(() => overviewWindow("0h")).toThrow("--since");
});


test("overview capability validates static facet identity before accessing the target", async () => {
  const { validatePluginDefinition } = await import("../src/plugin/definition");
  const valid = { id: "test", version: "0.0.1", services: createServiceCatalog([provider("api")]) };
  const manifest = {
    manifestVersion: 1 as const, pluginApiVersion: DOCTOR_PLUGIN_API_VERSION,
    id: "test", version: "0.0.1", requiresDoctor: ">=0.1.81",
    contentDigest: `sha256:${"0".repeat(64)}`, main: "./plugin.mjs", skills: [],
  };
  expect(validatePluginDefinition(valid, manifest).services.findWith("api", "overview")).toBeDefined();
  const invalid = provider("bad");
  invalid.capabilities.overview.facets = [facet, facet];
  expect(() => validatePluginDefinition({ ...valid, services: createServiceCatalog([invalid]) }, manifest))
    .toThrow("duplicate");
});

test("report preserves source IDs, text data and failed providers and escapes HTML", async () => {
  const { CommandContext } = await import("../src/command");
  const { writeOverviewReport } = await import("../src/overview/report");
  const { readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const result = await runOverviewSession([provider("api")], query, actions({
    summarize: async () => [{ facetId: "errors", description: "created_at", entries: [
      { key: "E1", label: "<error>", data: "<script>alert(1)</script>", canSample: true },
    ] }], select: async () => "errors",
    sample: async () => ({ bizId: "trace-1", source: { kind: "message_id", value: "m1" } }),
  }));
  const context = new CommandContext({});
  const directory = writeOverviewReport(result, context);
  try {
    writeOverviewReport(result, context, directory);
    expect(context.artifacts.list()).toHaveLength(1);
    const html = readFileSync(join(directory, "report.html"), "utf8");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("message_id: m1");
    expect(JSON.parse(readFileSync(join(directory, "diagnosis.json"), "utf8")).samples[0].bizId).toBe("trace-1");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("overview preserves partial collection status and cancellation", async () => {
  for (const status of [CommandStatus.Partial, CommandStatus.Cancelled]) {
    const result = await runOverviewSession([provider("api")], query, actions({
      select: async () => "errors",
      collect: async () => ({ status, output: undefined, artifacts: [] }),
    }));
    expect(result.collection).toBe(status);
    expect(result.samples).toHaveLength(2);
    expect(result.services[0]?.facets).toHaveLength(1);
  }
});
