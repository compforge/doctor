import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServiceCatalog, withSummary, type FacetSummarizeExtension, type FacetSampleExtension, type DurationSummarizeExtension,
  type HealthCaseBindingsExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus, commandOutcome } from "../src/command";
import { createDoctorProgram } from "../src/app/main";
import { healthCommand } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";
import { overviewProviders } from "../src/overview/extensions";
import { overviewCommand } from "../src/overview";
import { runOverviewSession } from "../src/overview/flow";
import { buildOverviewHtml } from "../src/overview/report";
import * as targets from "../src/command/kubernetes-target";
import * as caseRuntime from "../src/health/biz/runtime";

const query = { window: { from: "2026-10-01T00:00:00Z", to: "2026-10-01T01:00:00Z" }, maxEntries: 10 };
const facet = { id: "errors", title: "Errors", description: "Recorded errors" };
const summary = [{ facetId: facet.id, entries: [{ key: "E1", label: "Failure", data: 2, canSample: true }], description: "Errors" }];
const summarize: FacetSummarizeExtension = { id: "summary", kind: "facet.summarize", access: {}, facets: [facet],
  run: withSummary({ title: "Errors", fields: [] }, async () => summary) };
const sample: FacetSampleExtension = { id: "sample", kind: "facet.sample", access: {},
  run: withSummary({ title: "Samples", fields: [] }, async () => [{ bizId: "trace-1" }]) };
const consume: HealthCaseBindingsExtension = { id: "checks", kind: "health.case.bindings", access: {},
  run: withSummary({ title: "Checks", fields: [] }, async () => ({ bindings: [] })) };
const service = (extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({
  name: "api", aliases: ["short"], workloads: [], extensions,
  component: { name: "api", repository: { forge: { name: "fixture" }, path: "fixture/api" } },
});
const plugin = (extensions: ServiceDefinition["extensions"]) => ({
  id: "fixture", version: "1", services: createServiceCatalog([service(extensions)]),
});

test("Health prepares producer identity before checks and never persists it as a tenant filter", async () => {
  const calls: string[] = [];
  const producer = {
    access: {},
    requestIdentity: { configured: () => { calls.push("identity"); return { tenantId: "probe-tenant", userId: "probe-user" }; } },
    run: withSummary({ title: "Probe", fields: [] }, async () => ({ cases: [], reason: "No sample" })),
  };
  const definition = plugin([summarize, consume]);
  const api = definition.services.find("api")!;
  const { kubernetesServiceWorkload } = await import("@compforge/doctor-plugin");
  const ready = { ...api, workloads: [kubernetesServiceWorkload("api")], extensions: [
    { ...summarize, run: withSummary({ title: "Summary", fields: [] }, async (_ctx, input: import("@compforge/doctor-plugin").FacetSummaryQuery) => {
      expect(input.tenantId).toBeUndefined(); calls.push("summary"); return summary;
    }) },
    { ...consume, run: withSummary({ title: "Relations", fields: [] }, async () => {
      calls.push("consume");
      return { bindings: [{ id: "probe", workload: "main", producer: { service: "api", source: "probe" } }] };
    }) },
  ], cases: [{ id: "probe", load: () => [], produce: producer }] };
  const context = new CommandContext({}, undefined, { plugin: { ...definition, services: createServiceCatalog([ready]) } });
  context.ensureEnvironment = async () => {};
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture",
    kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
    run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }),
    exec: async () => { throw new Error("unexpected exec"); },
  });
  const checks = spyOn(caseRuntime, "caseCheckActions").mockImplementation((_ctx, _executor, _kube, directory, checkpoint) => ({
    directory, checkpoint, signal: context.signal,
    targets: async () => { calls.push("targets"); return { targets: [] }; },
    sender: async () => { throw new Error("unexpected sender"); },
    approve: async () => { throw new Error("unexpected approval"); },
    produce: async () => { throw new Error("unexpected production"); },
  }));
  try {
    const result = await healthCommand.run(context, { services: ["api"] });
    expect(calls).toEqual(["consume", "identity", "targets"]);
    expect(result.output?.query.tenantId).toBeUndefined();
    const artifact = result.artifacts[0]!;
    const evidence = readFileSync(join(artifact.path, "diagnosis.json"), "utf8");
    expect(evidence).not.toContain("probe-user");
    expect(evidence).not.toContain("probe-tenant");
  } finally {
    config.mockRestore(); executor.mockRestore(); checks.mockRestore();
    await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
  }
});

test("health discovers only checks and ignores statistics and sample implementations", () => {
  const definition = plugin([summarize, consume, sample, { ...sample, id: "another" }]);
  const selected = healthProviders(definition, ["short"])[0]!;
  expect(selected.name).toBe("api");
  expect(selected.consumers).toEqual([consume]);
  expect(selected).not.toHaveProperty("sample");
  expect(selected).not.toHaveProperty("summarize");
  expect(() => healthProviders(plugin([summarize]), ["api"])).toThrow("health.case.bindings");
  expect(() => overviewProviders(plugin([consume]), ["api"])).toThrow("facet.summarize");
  expect(overviewProviders(plugin([summarize]), ["api"])[0]!.summarize).toBe(summarize);
  expect(healthProviders(plugin([consume]))[0]!.consumers).toEqual([consume]);
});

test("health retains failed checks without statistics, sampling or collection fields", async () => {
  const selected = healthProviders(plugin([summarize, sample, consume]), ["api"]);
  const checkpoints: unknown[] = [];
  const result = await runHealthSession(selected, {}, {
    cases: async () => { throw new Error("probe preparation failed"); },
    show: current => checkpoints.push(structuredClone(current)),
  });
  expect(result.providers[0]).not.toHaveProperty("facets");
  expect(result.providers[0]!.casesError).toBe("probe preparation failed");
  expect(checkpoints).toHaveLength(2);
  expect(result.query).not.toHaveProperty("window");
  expect(result).not.toHaveProperty("samples");
  expect(result).not.toHaveProperty("collection");
  const html = buildHealthHtml(result);
  expect(html).toContain("probe preparation failed");
  expect(html).not.toContain("统计窗口");
  expect(html).not.toContain("采集状态");
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
  for (const flag of ["--since", "--collect", "--facet", "--sample-count", "--include", "--collect-concurrency"]) {
    expect(command.options.some(option => option.long === flag)).toBe(false);
  }
  const context = new CommandContext({}, undefined, { plugin: plugin([consume]) });
  const ensure = mock(async () => {});
  context.ensureEnvironment = async requirements => { if (requirements.kubernetes) await ensure(); };
  try {
    const result = await healthCommand.run(context, { services: ["missing"] });
    expect(result.status).toBe(CommandStatus.Failed);
    expect(ensure).not.toHaveBeenCalled();
  } finally { await context.disposeClients(); }
});

test("real commands separate checks from statistics and overview sampling", async () => {
  const calls: string[] = [];
  const displaySummary = [{ ...summary[0]!, entries: [...summary[0]!.entries,
    { key: "status", label: "System status", data: 1, canSample: false }] }];
  const cost: DurationSummarizeExtension = { id: "cost", kind: "duration.summarize", access: {},
    run: withSummary({ title: "Duration", fields: [] }, async () => {
      calls.push("cost"); return { description: "Startup duration", entries: [] };
    }) };
  const definition = plugin([
    { ...summarize, run: withSummary({ title: "Errors", fields: [] }, async ctx => {
      expect(ctx.target.service.name).toBe("api"); calls.push("summary"); return displaySummary;
    }) },
    cost, consume,
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
    for (const kind of ["health", "overview"] as const) {
      const context = new CommandContext({}, undefined, { plugin: definition });
      context.ensureEnvironment = async () => {};
      try {
        const result = kind === "health"
          ? await healthCommand.run(context, { services: ["short"] })
          : await overviewCommand.run(context, { since: "1h", services: ["short"], facet: "errors" });
        expect(result.status).toBe(CommandStatus.Ok);
        const artifact = result.artifacts.find(item => item.command === kind)!;
        const evidence = JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8"));
        if (kind === "health") {
          expect(evidence).not.toHaveProperty("samples");
          expect(evidence.providers[0]).not.toHaveProperty("facets");
          expect(evidence.providers[0]).not.toHaveProperty("cost");
        }
        else {
          expect(evidence.providers[0].facets).toEqual(displaySummary);
          expect(evidence.providers[0].cost.description).toBe("Startup duration");
          expect(evidence.samples[0].bizId).toBe("trace-1");
          expect(evidence.collection).toBe("not-requested");
        }
        expect(result.artifacts.every(item => item.command === kind)).toBe(true);
      } finally {
        await context.disposeClients();
        for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
      }
    }
    expect(calls).toEqual(["summary", "cost", "sample"]);
  } finally { config.mockRestore(); executor.mockRestore(); }
});

test("overview preserves display-only facets and only offers sampleable entries", async () => {
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
  const multiSummary: FacetSummarizeExtension = { ...summarize, facets: [facet, statusFacet, emptyFacet, truncatedFacet] };
  const definition = plugin([multiSummary, sample]);
  const shared = { summarize: async () => all, show: () => {} };
  const overview = await runOverviewSession(overviewProviders(definition, ["api"]), query, {
    ...shared, select: async () => undefined, sample: async () => [],
    confirmCollect: async () => false, collect: async () => commandOutcome(0),
  });
  expect(overview.providers[0]!.facets).toEqual(all);
  expect(all[0]!.entries).toHaveLength(2);
  expect(buildOverviewHtml(overview)).toContain("Display-only status");
  expect(buildOverviewHtml(overview)).toContain("source cap");

});

test("overview supports duration-only namespaces and rejects ambiguous statistics", () => {
  const cost: DurationSummarizeExtension = { id: "cost", kind: "duration.summarize", access: {},
    run: withSummary({ title: "Duration", fields: [] }, async () => ({ description: "Startup", entries: [] })) };
  expect(overviewProviders(plugin([cost]), ["api"])[0]!.cost).toBe(cost);
  const definition = plugin([summarize, sample, consume, cost, { ...cost, id: "second-cost" }]);
  expect(() => overviewProviders(definition, ["api"])).toThrow("ambiguous");
  expect(healthProviders(definition, ["api"])[0]!.consumers).toEqual([consume]);
});
