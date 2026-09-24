import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type CaseRunnerCreateExtension, type ServiceDefinition, type PluginDefinition, type PerfScenariosExtension } from "@compforge/doctor-plugin";
import { caseRunnerProvider, createCaseRunner } from "../src/case/extensions";
import { createHostPluginContext } from "../src/plugin/context";
import { selectEvalProvider, selectEvalCaseSet, executeEvalCases } from "../src/eval";
import { selectPerfProvider, loadPerfScenarios } from "../src/perf/extensions";
import { workloadFromCaseRunner } from "../src/perf";

const cases = { caseset: "chat", schema_version: 1 as const, facets: {}, cases: [{ id: "hello", input: { query: "hello" } }] };
const extension: CaseRunnerCreateExtension = {
  id: "runner", kind: "case.runner.create", endpoint: { host: "app", port: 8080 }, access: {}, caseSets: [cases],
  run: withSummary({"title":"Case Runner","fields":[]}, async () => ({ run: async () => ({ status: 200, durationMs: 1 }), classify: () => ({ ok: true }) }))
};
const scenarios: PerfScenariosExtension = { id: "scenarios", kind: "perf.scenarios", access: {}, run: withSummary({"title":"性能场景","fields":[{"label":"场景数","path":["length"]}]}, async () => [{ id: "chat", title: "Chat", description: "Load", caseSetId: "chat", cases: [{ caseId: "hello" }], observability: { metricServices: ["app"], logServices: ["app"], correlationKeys: ["trace_id"] } }]) };
const base: ServiceDefinition = {
  name: "app",
  aliases: ["chat"],
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};

test("native Case extension serves both Eval and Perf without legacy capability", async () => {
  const run = mock(extension.run);
  const services = createServiceCatalog([{ ...base, extensions: [{ ...extension, run }, scenarios] }]);
  const plugin: PluginDefinition = { id: "test", version: "0.0.1", services };
  const selected = selectEvalProvider(plugin, "chat");
  expect(selectEvalCaseSet(selected, undefined)).toEqual(cases);
  const perf = selectPerfProvider(services, "chat");
  expect(perf.cases.caseSets).toEqual([cases]);
  await loadPerfScenarios(perf, () => createHostPluginContext({ service: base, capability: scenarios }));
  expect(run).not.toHaveBeenCalled();
  const context = createHostPluginContext({ service: base, capability: extension });
  try {
    const runner = await createCaseRunner(selected.extension, context, { caseSetId: "chat", timeoutMs: 1000 });
    expect((await executeEvalCases(runner, cases.cases, "run", context.signal))[0]?.protocol?.ok).toBe(true);
    expect(workloadFromCaseRunner(runner)).toBeDefined();
  } finally { await context.dispose(); }
});

test("Case discovery rejects missing and ambiguous implementations", () => {
  const catalog = createServiceCatalog([{ ...base, extensions: [extension, { ...extension, id: "other" }] }]);
  expect(() => caseRunnerProvider(catalog, "app")).toThrow("Ambiguous");
  expect(() => caseRunnerProvider(catalog, "missing")).toThrow("No case.runner.create");
});

test("cancellation during creation transfers the runner to its cleanup owner", async () => {
  const controller = new AbortController();
  const cleanup = mock(async () => { });
  const run = mock(async () => ({ status: 200, durationMs: 1 }));
  const factory: CaseRunnerCreateExtension = {
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
