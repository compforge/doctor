import { perfExtension } from "./extension-fixture";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, perfScenariosOutput, requirePerfScenariosExtension,
  type ServiceDefinition, type ServicePerfScenario
} from "../src";
const scenario: ServicePerfScenario = {
  id: "chat", title: "Chat", description: "Chat load", caseSetId: "chat",
  cases: [{ caseId: "hello" }], observability: { metricServices: ["app"], logServices: ["app"], correlationKeys: ["trace_id"] }
};
const service: ServiceDefinition = {
  name: "app",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};

test("Perf declarations adapt without executing a provider during discovery", async () => {
  const legacy = createServiceCatalog([{
    ...service,
    extensions: [perfExtension({ scenarios: [scenario] })]
  }]);
  const extension = requirePerfScenariosExtension(legacy.extensions("perf.scenarios")[0]!.extension);
  expect(extension.access).toEqual({});
  expect(await extension.run({} as never, undefined)).toEqual([scenario]);
  const run = mock(async () => [scenario]);
  const native = createServiceCatalog([{ ...service, extensions: [{ ...extension, run }] }]);
  expect(native.extensions("perf.scenarios")).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
  expect(() => createServiceCatalog([{
    ...service,
    extensions: [extension,
      perfExtension({ scenarios: [scenario] })]
  }])).toThrow("duplicate");
});

test("Perf output validates identities, Case weights and observability references", () => {
  expect(perfScenariosOutput([scenario])).toEqual([scenario]);
  for (const invalid of [[], [scenario, scenario], [{ ...scenario, cases: [] }],
  [{ ...scenario, cases: [{ caseId: "hello", weight: -1 }] }],
  [{ ...scenario, cases: [{ caseId: "hello", weight: 0 }] }],
  [{ ...scenario, cases: [{ caseId: "hello", weight: Infinity }] }],
  [{ ...scenario, cases: [{ caseId: "hello" }, { caseId: "hello" }] }],
  [{ ...scenario, observability: { ...scenario.observability, metricServices: [] } }],
  ]) expect(() => perfScenariosOutput(invalid)).toThrow();
});
