import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceCatalog, withSummary, type OverviewSummarizeExtension, type OverviewSampleExtension, type OverviewCostExtension,
  type CaseConsumeExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus, commandOutcome } from "../src/command";
import { createDoctorProgram } from "../src/app/main";
import { healthCommand } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";
import { overviewProviders } from "../src/overview/extensions";
import { sampleCommand } from "../src/overview";
import { runOverviewSession } from "../src/overview/flow";
import { buildOverviewHtml } from "../src/overview/report";
import * as targets from "../src/command/kubernetes-target";

const query = { window: { from: "2026-10-01T00:00:00Z", to: "2026-10-01T01:00:00Z" }, maxEntries: 10 };
const facet = { id: "errors", title: "Errors", description: "Recorded errors" };
const summary = [{ facetId: facet.id, entries: [{ key: "E1", label: "Failure", data: 2, canSample: true }], description: "Errors" }];
const summarize: OverviewSummarizeExtension = { id: "summary", kind: "overview.summarize", access: {}, facets: [facet],
  run: withSummary({ title: "Errors", fields: [] }, async () => summary) };
const sample: OverviewSampleExtension = { id: "sample", kind: "overview.sample", access: {},
  run: withSummary({ title: "Samples", fields: [] }, async () => [{ bizId: "trace-1" }]) };
const consume: CaseConsumeExtension = { id: "checks", kind: "case.consume", access: {},
  run: withSummary({ title: "Checks", fields: [] }, async () => ({ bindings: [] })) };
const service = (extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({
  name: "api", aliases: ["short"], workloads: [], extensions,
  component: { name: "api", repository: { forge: { name: "fixture" }, path: "fixture/api" } },
});
const plugin = (extensions: ServiceDefinition["extensions"]) => ({
  id: "fixture", version: "1", services: createServiceCatalog([service(extensions)]),
});

test("health discovers statistics and Cases without inspecting sample implementations", () => {
  const definition = plugin([summarize, consume, sample, { ...sample, id: "another" }]);
  const selected = healthProviders(definition, ["short"])[0]!;
  expect(selected.name).toBe("api");
  expect(selected.consumers).toEqual([consume]);
  expect(selected.sample).toBeUndefined();
  expect(healthProviders(plugin([consume]), ["api"])[0]!.summarize).toBeUndefined();
  expect(healthProviders(plugin([summarize]), ["api"])[0]!.summarize).toBe(summarize);
  expect(() => overviewProviders(plugin([summarize]), ["api"])).toThrow("doctor health");
  expect(() => overviewProviders(plugin([consume]), ["api"])).toThrow("doctor health");
  expect(() => healthProviders(plugin([]), ["api"])).toThrow("case.consume");
  expect(healthProviders(plugin([consume]))[0]!.consumers).toEqual([consume]);
});

test("health flow preserves statistics and failed probes without lookup or collection fields", async () => {
  const selected = healthProviders(plugin([summarize, sample, consume]), ["api"]);
  const checkpoints: unknown[] = [];
  const result = await runHealthSession(selected, query, {
    summarize: async (_provider, input) => { expect(input).toBe(query); return summary; },
    cases: async () => { throw new Error("probe preparation failed"); },
    show: current => checkpoints.push(structuredClone(current)),
  });
  expect(result.providers[0]!.facets).toEqual(summary);
  expect(result.providers[0]!.casesError).toBe("probe preparation failed");
  expect(checkpoints).toHaveLength(2);
  expect(result).not.toHaveProperty("samples");
  expect(result).not.toHaveProperty("collection");
  const html = buildHealthHtml(result);
  expect(html).toContain("probe preparation failed");
  expect(html).not.toContain("采集状态");
  expect(html).not.toContain("代表对象");
});

test("overview ignores Case consumers and shows samples before collection consent", async () => {
  const consumeRun = mock(async () => { throw new Error("overview must not execute Cases"); });
  const selected = overviewProviders(plugin([summarize, sample, { ...consume, run: consumeRun }]), ["api"]);
  expect(selected[0]).not.toHaveProperty("consumers");
  const collect = mock(async () => commandOutcome(0));
  const order: string[] = [];
  const result = await runOverviewSession(selected, query, {
    summarize: async () => summary,
    select: async () => facet.id,
    sample: async () => { order.push("lookup"); return [{ bizId: "trace-1" }]; },
    show: current => { if (current.samples.length) order.push("show-ids"); },
    confirmCollect: async ids => { expect(ids).toEqual(["trace-1"]); order.push("consent"); return false; },
    collect,
  });
  expect(order).toEqual(["lookup", "show-ids", "consent"]);
  expect(collect).not.toHaveBeenCalled();
  expect(consumeRun).not.toHaveBeenCalled();
  expect(result.samples[0]!.bizId).toBe("trace-1");
  expect(result.collection).toBe("not-requested");
});

test("health exposes no collection flags and rejects unknown scopes before environment access", async () => {
  const command = createDoctorProgram().commands.find(item => item.name() === "health")!;
  expect(command).toBeDefined();
  for (const flag of ["--collect", "--facet", "--sample-count", "--include", "--collect-concurrency"]) {
    expect(command.options.some(option => option.long === flag)).toBe(false);
  }
  const context = new CommandContext({}, undefined, { plugin: plugin([consume]) });
  const ensure = mock(async () => {});
  context.ensureEnvironment = async requirements => { if (requirements.kubernetes) await ensure(); };
  try {
    const result = await healthCommand.run(context, { since: "1h", service: "missing" });
    expect(result.status).toBe(CommandStatus.Failed);
    expect(ensure).not.toHaveBeenCalled();
  } finally { await context.disposeClients(); }
});

test("real commands share statistics, but only overview --facet queries IDs without collection", async () => {
  const calls: string[] = [];
  const displaySummary = [{ ...summary[0]!, entries: [...summary[0]!.entries,
    { key: "status", label: "System status", data: 1, canSample: false }] }];
  const cost: OverviewCostExtension = { id: "cost", kind: "overview.cost", access: {},
    run: withSummary({ title: "Duration", fields: [] }, async () => {
      calls.push("cost"); return { description: "Startup duration", entries: [] };
    }) };
  const definition = plugin([
    { ...summarize, run: withSummary({ title: "Errors", fields: [] }, async ctx => {
      expect(ctx.target.service.name).toBe("api"); calls.push("summary"); return displaySummary;
    }) },
    cost,
    { ...sample, run: withSummary({ title: "Samples", fields: [] }, async ctx => {
      expect(ctx.target.service.name).toBe("api"); calls.push("sample"); return [{ bizId: "trace-1" }];
    }) },
  ]);
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture",
    kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
    run: async args => {
      if (args[0] !== "config") throw new Error("unexpected I/O");
      return { ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false };
    }, exec: async () => { throw new Error("unexpected exec"); },
  });
  try {
    for (const kind of ["health", "sample"] as const) {
      const context = new CommandContext({}, undefined, { plugin: definition });
      context.ensureEnvironment = async () => {};
      try {
        const result = kind === "health"
          ? await healthCommand.run(context, { since: "1h", service: "short" })
          : await sampleCommand.run(context, { since: "1h", service: "short", facet: "errors" });
        expect(result.status).toBe(CommandStatus.Ok);
        const artifact = result.artifacts.find(item => item.command === kind)!;
        const evidence = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8"));
        if (kind === "health") {
          expect(evidence).not.toHaveProperty("samples");
          expect(evidence.providers[0].facets).toEqual(displaySummary);
          expect(evidence.providers[0].cost.description).toBe("Startup duration");
        }
        else {
          expect(evidence.providers[0].facets).toEqual(summary);
          expect(evidence.providers[0]).not.toHaveProperty("cost");
          expect(evidence.samples[0].bizId).toBe("trace-1");
          expect(evidence.collection).toBe("not-requested");
        }
        expect(result.artifacts.every(item => item.command === kind)).toBe(true);
      } finally {
        await context.disposeClients();
        for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
      }
    }
    expect(calls).toEqual(["summary", "cost", "summary", "sample"]);
  } finally { config.mockRestore(); executor.mockRestore(); }
});

test("overview projects selectable entries, while health retains display-only facets", async () => {
  const statusFacet = { id: "status", title: "Status", description: "System state" };
  const emptyFacet = { id: "empty", title: "Empty", description: "No matching objects" };
  const truncatedFacet = { id: "truncated", title: "Truncated", description: "Bounded query" };
  const displayEntry = { key: "up", label: "Display-only status", data: "up", canSample: false };
  const all = [
    { ...summary[0]!, entries: [...summary[0]!.entries, displayEntry] },
    { facetId: "status", description: "Status", entries: [displayEntry] },
    { facetId: "empty", description: "Empty", entries: [] },
    { facetId: "truncated", description: "Bounded query", entries: [displayEntry], truncated: { reason: "source cap" } },
  ];
  const multiSummary: OverviewSummarizeExtension = { ...summarize, facets: [facet, statusFacet, emptyFacet, truncatedFacet] };
  const definition = plugin([multiSummary, sample]);
  const shared = { summarize: async () => all, show: () => {} };
  const overview = await runOverviewSession(overviewProviders(definition, ["api"]), query, {
    ...shared, select: async () => undefined, sample: async () => [],
    confirmCollect: async () => false, collect: async () => commandOutcome(0),
  });
  const health = await runHealthSession(healthProviders(definition, ["api"]), query, {
    ...shared, cases: async () => [],
  });
  expect(overview.providers[0]!.facets.map(item => item.facetId)).toEqual(["errors", "empty", "truncated"]);
  expect(overview.providers[0]!.facets[2]!.truncated?.reason).toBe("source cap");
  expect(overview.providers[0]!.facets[0]!.entries).toEqual(summary[0]!.entries);
  expect(health.providers[0]!.facets).toEqual(all);
  expect(all[0]!.entries).toHaveLength(2);
  expect(buildOverviewHtml(overview)).not.toContain("Display-only status");
  expect(buildOverviewHtml(overview)).toContain("source cap");
  expect(buildHealthHtml(health)).toContain("Display-only status");
});

test("overview discovery does not validate or borrow duration-only capabilities", () => {
  const cost: OverviewCostExtension = { id: "cost", kind: "overview.cost", access: {},
    run: withSummary({ title: "Duration", fields: [] }, async () => ({ description: "Startup", entries: [] })) };
  expect(() => overviewProviders(plugin([cost]), ["api"])).toThrow("doctor health");
  const definition = plugin([summarize, sample, cost, { ...cost, id: "second-cost" }]);
  const selected = overviewProviders(definition, ["api"])[0]!;
  expect(selected).not.toHaveProperty("cost");
  expect(selected).not.toHaveProperty("costService");
  expect(() => healthProviders(definition, ["api"])).toThrow("ambiguous");
});
