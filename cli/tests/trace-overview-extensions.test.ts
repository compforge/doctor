import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type ServiceDefinition, type TraceResolveExtension, type PluginContext,
  type OverviewSummarizeExtension, type OverviewSampleExtension } from "@compforge/doctor-plugin";
import { resolvePluginTraceIds } from "../src/plugin/trace-id";
import { overviewProviders } from "../src/overview/extensions";
import { evaluatePluginCapabilities } from "../src/command/plugin-capability";
import { PLUGIN_COMMAND_CAPABILITIES } from "../src/command/plugin-command-capabilities";

const service = (name: string, extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({
  name, component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } },
  workloads: [], capabilities: {}, extensions,
});
const trace = (run: TraceResolveExtension["run"]): TraceResolveExtension => ({
  id: "trace", kind: "trace.resolve", endpoint: { host: "test", port: 80 }, access: {}, run,
});
const facet = { id: "errors", title: "Errors", description: "Recorded errors" };
const summarize: OverviewSummarizeExtension = {
  id: "summary", kind: "overview.summarize", access: {}, facets: [facet], run: async () => [],
};
const sample: OverviewSampleExtension = {
  id: "sample", kind: "overview.sample", access: { kubernetes: [{ requirement: "required",
    purpose: "sample", rule: { verb: "get", resource: "configmaps" } }] }, run: async () => [],
};

test("native trace extensions resolve batches with fallback, provenance and deduplication", async () => {
  const first = mock(async (_ctx: PluginContext, { bizId }: { bizId: string }) => bizId === "one"
    ? [{ traceId: "t1", resolvedAs: "conversation", sourceId: "m1" }, { traceId: "t1", resolvedAs: "conversation" }] : undefined);
  const second = mock(async () => ({ traceId: "t2", resolvedAs: "message" }));
  const services = createServiceCatalog([service("first", [trace(first)]), service("second", [trace(second)])]);
  const plugin = { id: "test", version: "1", services };
  const result = await resolvePluginTraceIds({ bizIds: ["one", "two"], namespace: "test", profileName: "test", command: "doctor trace" },
    plugin, { run: async () => { throw new Error("unexpected I/O"); }, exec: async () => { throw new Error("unexpected I/O"); } },
    { first: {} as PluginContext, second: {} as PluginContext });
  expect(result.map(item => [item.bizId, item.traceId, item.service])).toEqual([["one", "t1", "first"], ["two", "t2", "second"]]);
  expect(result[0]?.sourceId).toBe("m1");
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(1);
});

test("overview discovers native operations without invoking them or combining their access", () => {
  const run = mock(async () => []);
  const services = createServiceCatalog([service("chat", [{ ...summarize, run }, sample])]);
  const provider = overviewProviders(services)[0]!;
  expect(provider.summarize.access).toEqual({});
  expect(provider.sample?.access).toEqual(sample.access);
  expect(run).not.toHaveBeenCalled();
  expect(evaluatePluginCapabilities({ id: "test", version: "1", services }, PLUGIN_COMMAND_CAPABILITIES.overview).runnable).toBe(true);
});

test("overview supports summaries without sampling and rejects ambiguous producers", () => {
  expect(overviewProviders(createServiceCatalog([service("chat", [summarize])]))[0]?.sample).toBeUndefined();
  expect(() => overviewProviders(createServiceCatalog([service("chat", [summarize, { ...summarize, id: "second" }])]))).toThrow("ambiguous");
  const invalid: OverviewSummarizeExtension = { ...summarize, facets: [facet, facet] };
  expect(() => overviewProviders(createServiceCatalog([service("chat", [invalid])]))).toThrow("duplicate");
});
