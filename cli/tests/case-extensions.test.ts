import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type CaseCatalog, type CaseRunnerFactory, type ServiceDefinition, type PluginDefinition, type PerfScenariosExtension } from "@compforge/doctor-plugin";
import { caseRunnerProvider, createCaseRunner, runnableCaseCatalog, runnerCaseCatalog } from "../src/case/runners";
import { doctorCaseCatalog, selectDoctorCases } from "../src/case/catalog";
import { createHostPluginContext } from "../src/plugin/context";
import { selectEvalProvider, executeEvalCases } from "../src/eval";
import { selectPerfProvider, loadPerfScenarios } from "../src/perf/extensions";
import { workloadFromCaseRunner } from "../src/perf";

const cases = { caseset: "chat", schema_version: 1 as const, facets: {}, cases: [{ id: "hello", input: { query: "hello" } }] };
const extension: CaseRunnerFactory = {
  endpoint: { host: "app", port: 8080 }, access: {},
  supports: item => typeof item.input.query === "string",
  run: withSummary({"title":"Case Runner","fields":[]}, async () => ({ run: async () => ({ status: 200, durationMs: 1 }), classify: () => ({ ok: true }) }))
};
const scenarios: PerfScenariosExtension = { id: "scenarios", kind: "perf.scenarios", access: {}, run: withSummary({"title":"性能场景","fields":[{"label":"场景数","path":["length"]}]}, async () => [{ id: "chat", title: "Chat", description: "Load", cases: { service: "app", source: "chat" }, observability: { metricServices: ["app"], logServices: ["app"], correlationKeys: ["trace_id"] } }]) };
const catalog: CaseCatalog = { id: "test.cases", load: () => [{
  ...cases, facets: { command: { values: ["eval,perf"] } },
  cases: cases.cases.map((item) => ({ ...item, facets: { command: "eval,perf" } })),
}] };
const base: ServiceDefinition = {
  name: "app",
  aliases: ["chat"],
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};

test("native Case resource serves both Eval and Perf without legacy capability", async () => {
  const run = mock(extension.run);
  const services = createServiceCatalog([{ ...base, cases: [{ id: "chat", load: catalog.load, runner: { ...extension, run } }], extensions: [scenarios] }]);
  const plugin: PluginDefinition = { id: "test", version: "0.0.1", services };
  const selected = selectEvalProvider(plugin, "chat");
  expect((await selectDoctorCases({ catalog: doctorCaseCatalog(plugin), command: "eval", supports: item => typeof item.input.query === "string", caseSetId: "chat" }))?.cases.map((item) => item.id)).toEqual(["hello"]);
  const perf = selectPerfProvider(services, "chat");
  expect((await selectDoctorCases({ catalog: doctorCaseCatalog(plugin), command: "perf", supports: item => typeof item.input.query === "string", caseSetId: "chat" }))?.cases.map((item) => item.id)).toEqual(["hello"]);
  await loadPerfScenarios(perf, () => createHostPluginContext({ service: base, capability: scenarios }));
  expect(run).not.toHaveBeenCalled();
  const context = createHostPluginContext({ service: base, capability: extension });
  try {
    const runner = await createCaseRunner(selected.factory, context, { caseSetId: "chat", timeoutMs: 1000 });
    expect((await executeEvalCases(runner, cases.cases, "run", context.signal))[0]?.protocol?.ok).toBe(true);
    expect(workloadFromCaseRunner(runner)).toBeDefined();
  } finally { await context.dispose(); }
});

test("Case discovery rejects missing and ambiguous implementations", () => {
  const catalog = createServiceCatalog([{ ...base, cases: ["chat", "other"].map(id => ({ id, load: () => [cases], runner: extension })) }]);
  expect(() => caseRunnerProvider(catalog, "app")).toThrow("Ambiguous");
  expect(() => caseRunnerProvider(catalog, "missing")).toThrow("No Case runner");
  expect(caseRunnerProvider(catalog, "app", "other").source.id).toBe("other");
});

test("Perf scenario may reference another Service's source without borrowing the scenario owner's access", async () => {
  const services = createServiceCatalog([
    { ...base, name: "workflow", aliases: [], extensions: [scenarios] },
    { ...base, cases: [{ id: "chat", load: catalog.load, runner: extension }] },
  ]);
  const workflow = selectPerfProvider(services, "workflow");
  const declared = await loadPerfScenarios(workflow, () => createHostPluginContext({ service: workflow.service, capability: scenarios }));
  const ref = declared[0]!.cases;
  const selected = caseRunnerProvider(services, ref.service, ref.source);
  expect(selected.service.name).toBe("app");
  expect(selected.factory.endpoint).toEqual(extension.endpoint);
  expect(() => caseRunnerProvider(services, "app", "missing")).toThrow("No Case runner");
});

test("Eval selects a source before its runner and cannot execute another source's incompatible Cases", async () => {
  const other = { caseset: "other", cases: [{ id: "file", input: { file: "example" } }] };
  const services = createServiceCatalog([{ ...base, cases: [
    { id: "chat", load: catalog.load, runner: extension },
    { id: "files", load: () => [other], runner: { ...extension, supports: item => typeof item.input.file === "string" } },
  ] }]);
  const plugin = { id: "test", version: "1", services };
  const all = doctorCaseCatalog(plugin);
  const selection = await selectDoctorCases({ catalog: runnableCaseCatalog(all, services, "app"), command: "eval", caseSetId: "other" });
  const provider = selectEvalProvider(plugin, selection!.source.service, selection!.source.sourceId, selection!.cases);
  expect(provider.source.id).toBe("files");
  expect(runnerCaseCatalog(all, provider).map(item => item.caseSet.caseset)).toEqual(["other"]);
  expect(() => selectEvalProvider(plugin, "app", "chat", selection!.cases)).toThrow("No Case runner");
});

test("cancellation during creation transfers the runner to its cleanup owner", async () => {
  const controller = new AbortController();
  const cleanup = mock(async () => { });
  const run = mock(async () => ({ status: 200, durationMs: 1 }));
  const factory: CaseRunnerFactory = {
    ...extension, run: withSummary({ title: "Fixture", fields: [] }, async () => {
      controller.abort();
      return { run, cleanup, classify: () => ({ ok: true }) };
    })
  };
  const context = createHostPluginContext({ service: base, capability: factory, signal: controller.signal });
  const runner = await createCaseRunner(factory, context, { caseSetId: "chat", timeoutMs: 1000 });
  expect(context.signal.aborted).toBe(true);
  expect(await executeEvalCases(runner, cases.cases, "run", context.signal)).toEqual([]);
  await runner.cleanup?.({ runId: "run", signal: context.signal });
  await context.dispose();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

test("pre-cancelled creation never invokes the factory", async () => {
  const controller = new AbortController();
  controller.abort();
  const run = mock(extension.run);
  const context = createHostPluginContext({ service: base, capability: extension, signal: controller.signal });
  await expect(createCaseRunner({ ...extension, run }, context, { caseSetId: "chat", timeoutMs: 1000 })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  await context.dispose();
});

test("Perf Harness owns lazy creation and cleanup when cancellation races with setup", async () => {
  const { Engine, rampHold } = await import("@compforge/perf-harness");
  const { workloadFromCaseFactory } = await import("../src/perf");
  for (const preCancelled of [true, false]) {
    const controller = new AbortController();
    const cleanup = mock(async () => { });
    const fire = mock(async () => ({ status: 200, durationMs: 1 }));
    const create = mock(async () => {
      controller.abort();
      return { run: fire, cleanup, classify: () => ({ ok: true }) };
    });
    if (preCancelled) controller.abort();
    await new Engine({
      name: "test", subject: { name: "test", target: {} },
      workload: workloadFromCaseFactory(create), caseSet: cases,
      loads: [rampHold("closed", 1, 0, 1, { max_requests: 1 })], signal: controller.signal,
    }).run();
    expect(create).toHaveBeenCalledTimes(preCancelled ? 0 : 1);
    expect(cleanup).toHaveBeenCalledTimes(preCancelled ? 0 : 1);
    expect(fire).not.toHaveBeenCalled();
  }
});
