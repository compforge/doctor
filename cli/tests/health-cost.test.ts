import { expect, mock, spyOn, test } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServiceCatalog, withSummary, type OverviewCostExtension, type OverviewCostResult,
  type OverviewSummarizeExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { healthProviders } from "../src/health/extensions";
import { checkedCost } from "../src/overview/cost";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";
import { healthCommand } from "../src/health";
import { CommandContext, CommandStatus } from "../src/command";
import * as targets from "../src/command/kubernetes-target";

const query = { window: { from: "2026-09-30T00:00:00Z", to: "2026-09-30T01:00:00Z" }, maxEntries: 10, maxRecords: 1000 };
const costResult: OverviewCostResult = { description: "completed startup intervals", entries: [
  { key: "start", label: "<start>", sampleCount: 2, missingCount: 3,
    durationMs: { min: 1, avg: 2, p50: 1, p95: 3, max: 3 } },
  { key: "empty", label: "Empty", sampleCount: 0, missingCount: 5 },
] };
const cost: OverviewCostExtension = { id: "cost", kind: "overview.cost", access: {},
  run: withSummary({ title: "Costs", fields: [] }, async () => costResult) };
const summarize: OverviewSummarizeExtension = { id: "summary", kind: "overview.summarize", access: {},
  facets: [{ id: "errors", title: "Errors", description: "Errors" }],
  run: withSummary({ title: "Errors", fields: [] }, async () => [{ facetId: "errors", description: "Errors", entries: [] }]) };
const service = (name: string, extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({
  name, aliases: [], workloads: [], extensions,
  component: { name, repository: { forge: { name: "fixture" }, path: `fixture/${name}` } },
});
const plugin = (extensions: ServiceDefinition["extensions"]) => ({ id: "fixture", version: "1",
  services: createServiceCatalog([service("api", extensions)]) });

test("health supports cost-only namespaces without borrowing summary or sample", () => {
  const definition = plugin([cost, { ...summarize, namespace: "plugin/fixture" }]);
  expect(healthProviders(definition, ["api"])[0]).toMatchObject({ cost, costService: { name: "api" }, summarize: undefined });
  expect(healthProviders(definition)[0]?.cost).toBeUndefined();
  expect(() => healthProviders(plugin([cost, { ...cost, id: "other" }]), ["api"])).toThrow("ambiguous");
});

test("duration validation rejects fake zeros, invalid statistics and over-budget populations", () => {
  expect(checkedCost(costResult, query)).toEqual(costResult);
  const entry = costResult.entries[0]!;
  for (const change of [{ sampleCount: 0 }, { sampleCount: -1 }, { missingCount: 1.5 }, { missingCount: 1000 },
    { durationMs: undefined }, { durationMs: { ...entry.durationMs!, avg: NaN } },
    { durationMs: { ...entry.durationMs!, p95: 0 } }]) {
    expect(() => checkedCost({ ...costResult, entries: [{ ...entry, ...change }] }, query)).toThrow();
  }
  expect(() => checkedCost({ ...costResult, entries: [entry, entry] }, query)).toThrow("duplicate");
  expect(checkedCost({ ...costResult, truncated: { reason: "source cap" } }, { ...query, maxEntries: 1 }).truncated?.reason).toContain("source cap");
});

test("summary and cost fail independently and cost-only never samples", async () => {
  for (const failed of ["summary", "cost", "neither"] as const) {
    const providers = healthProviders(plugin(failed === "neither" ? [cost] : [cost, summarize]), ["api"]);
    const cases = mock(async () => []);
    const result = await runHealthSession(providers, query, {
      summarize: async () => { if (failed === "summary") throw new Error("summary failed"); return [{ facetId: "errors", description: "Errors", entries: [] }]; },
      cost: async (_provider, input) => { expect(input.maxRecords).toBe(1000); expect(input.window).toEqual(query.window);
        if (failed === "cost") throw new Error("cost failed"); return costResult; },
      cases, show: () => {},
    });
    const output = result.providers[0]!;
    expect(output.error).toBe(failed === "summary" ? "summary failed" : undefined);
    expect(output.costError).toBe(failed === "cost" ? "cost failed" : undefined);
    expect(output.cost).toEqual(failed === "cost" ? undefined : costResult);
    expect(output.facets.length).toBe(failed === "cost" ? 1 : 0);
    expect(cases).not.toHaveBeenCalled();
    const html = buildHealthHtml(result);
    if (output.cost) { expect(html).toContain("&lt;start&gt;"); expect(html).toContain("P95 ms"); expect(html).toContain("—"); }
  }
});

test("command retains independent owners, typed evidence and partial status, including cost-only", async () => {
  const calls: string[] = [];
  const definition = { id: "fixture", version: "1", services: createServiceCatalog([
    service("api", [{ ...summarize, namespace: "plugin/fixture", run: withSummary({ title: "Errors", fields: [] }, async context => {
      expect(context.target.service.name).toBe("api"); calls.push("summary"); throw new Error("summary offline");
    }) }]),
    service("store", [cost, { ...cost, id: "product-cost", namespace: "plugin/fixture",
      run: withSummary({ title: "Costs", fields: [] }, async context => {
        expect(context.target.service.name).toBe("store"); calls.push("cost"); return costResult;
      }) }]),
  ]) };
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture",
    kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({
    run: async args => {
      if (args[0] !== "config") throw new Error("unexpected I/O");
      return { ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false };
    }, exec: async () => { throw new Error("unexpected exec"); },
  });
  try {
    for (const selection of [undefined, "store"]) {
      const context = new CommandContext({}, undefined, { plugin: definition });
      context.ensureEnvironment = async () => {};
      let artifacts: readonly { command: string; path: string }[] = [];
      try {
        const result = await healthCommand.run(context, { since: "1h", service: selection });
        expect(result.status).toBe(selection ? CommandStatus.Ok : CommandStatus.Partial);
        expect(result.output?.providers[0]?.cost).toEqual(costResult);
        artifacts = result.artifacts;
        const artifact = artifacts.find(item => item.command === "health")!;
        expect(JSON.parse(readFileSync(join(artifact.path, "diagnosis.json"), "utf8")).providers[0].cost).toEqual(costResult);
      } finally {
        await context.disposeClients();
        for (const artifact of artifacts) rmSync(artifact.path, { recursive: true, force: true });
      }
    }
    expect(calls).toEqual(["summary", "cost"]);
  } finally { config.mockRestore(); executor.mockRestore(); }
});
