import { caseExtension } from "../../packages/plugin/tests/extension-fixture";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type ServiceDefinition, type ServicePerfScenario, type PerfScenariosExtension } from "@compforge/doctor-plugin";
import { createHostPluginContext } from "../src/plugin/context";
import { loadPerfScenarios, selectPerfProvider } from "../src/perf/extensions";
const scenario: ServicePerfScenario = {
  id: "chat", title: "Chat", description: "Chat load", caseSetId: "chat",
  cases: [{ caseId: "hello" }], observability: { metricServices: ["app"], logServices: ["app"], correlationKeys: ["trace_id"] }
};
const createRunner = mock(async () => ({ run: async () => ({ status: 200, durationMs: 1 }), classify: () => ({ ok: true }) }));
const service: ServiceDefinition = {
  name: "app",
  aliases: ["chat"],
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: [],
  extensions: [caseExtension({
    endpoint: { host: "app", port: 8080 }, access: {},
    caseSets: [{ caseset: "chat", schema_version: 1, facets: {}, cases: [{ id: "hello", input: { query: "Hello" } }] }], createRunner
  })]
};
const extension: PerfScenariosExtension = { id: "scenarios", kind: "perf.scenarios", access: {}, run: async () => [scenario] };
const providerFor = (item = extension) => selectPerfProvider(createServiceCatalog([{ ...service, extensions: [...(service.extensions ?? []), item] }]), "chat");

test("native Perf selection supports aliases and stays offline until the authorized call", async () => {
  const cleanup = mock(() => { });
  const run = mock(async (context: Parameters<PerfScenariosExtension["run"]>[0]) => {
    context.onDispose(cleanup);
    return [scenario];
  });
  const provider = providerFor({ ...extension, run });
  expect(provider.service.name).toBe("app");
  expect(run).not.toHaveBeenCalled();
  const result = await loadPerfScenarios(provider, () => createHostPluginContext({ service, capability: provider.extension }));
  expect(result).toEqual([scenario]);
  expect(run).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(createRunner).not.toHaveBeenCalled();
});

test("Perf requires one implementation and an associated Case capability", () => {
  const duplicate = createServiceCatalog([{ ...service, extensions: [extension, { ...extension, id: "second" }] }]);
  expect(() => selectPerfProvider(duplicate, "app")).toThrow("Ambiguous");
  const missing = createServiceCatalog([{
    ...service,
    extensions: [extension]
  }]);
  expect(() => selectPerfProvider(missing, "app")).toThrow("case.runner.create");
  expect(() => selectPerfProvider(missing, "unknown")).toThrow("No perf.scenarios");
});

test("Perf validates Case references and releases configuration scope on failure", async () => {
  for (const invalid of [{ ...scenario, caseSetId: "missing" }, { ...scenario, cases: [{ caseId: "missing" }] }]) {
    const cleanup = mock(() => { });
    const provider = providerFor({ ...extension, run: async context => { context.onDispose(cleanup); return [invalid]; } });
    await expect(loadPerfScenarios(provider, () => createHostPluginContext({ service, capability: extension }))).rejects.toThrow("references unknown");
    expect(cleanup).toHaveBeenCalledTimes(1);
  }
  expect(createRunner).not.toHaveBeenCalled();
});

test("access denial and cancellation prevent the scenario function from running", async () => {
  const run = mock(async () => [scenario]);
  const provider = providerFor({ ...extension, run });
  await expect(loadPerfScenarios(provider, async () => { throw new Error("permission denied"); })).rejects.toThrow("permission denied");
  const controller = new AbortController();
  controller.abort();
  const context = createHostPluginContext({ service, capability: extension, signal: controller.signal });
  const dispose = mock(context.dispose);
  await expect(loadPerfScenarios(provider, () => ({ ...context, dispose }))).rejects.toThrow();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});
