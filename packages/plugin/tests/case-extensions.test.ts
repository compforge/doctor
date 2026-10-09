import { withSummary } from "@compforge/doctor-plugin";
import { caseRunnerFixture } from "./extension-fixture";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, caseRunner, validateCaseRunnerFactory, caseRunnerOutput,
  type CaseRunnerFactory, type ServiceDefinition
} from "../src";
const runner = { run: async () => ({ status: 200, durationMs: 1 }), classify: () => ({ ok: true }) };
const extension: CaseRunnerFactory = { supports: item => typeof item.input.query === "string", access: {}, endpoint: { host: "app", port: 8080 }, run: withSummary({"title":"Case Runner","fields":[]}, async () => runner) };
const base: ServiceDefinition = {
  name: "app",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};

test("Case runner declaration does not create a runner during discovery", async () => {
  const createRunner = mock(async () => runner);
  const service = {
    ...base,
    cases: [{ id: "chat", load: () => [], runner: caseRunnerFixture({ endpoint: extension.endpoint, access: {}, createRunner }) }]
  };
  const catalog = createServiceCatalog([service]);
  const declared = caseRunner(catalog.caseSource({ service: "app", source: "chat" }).source);
  expect(createRunner).not.toHaveBeenCalled();
  const options = { caseSetId: "chat", timeoutMs: 1000 };
  expect((await declared.run({} as never, options)).data).toBe(runner);
  expect(createRunner).toHaveBeenCalledTimes(1);
  expect(() => createServiceCatalog([{ ...service, cases: [...service.cases, ...service.cases] }])).toThrow("duplicate");
});

test("Case runner endpoint and result are checked at the seam", () => {
  expect(() => validateCaseRunnerFactory(extension)).not.toThrow();
  expect(() => validateCaseRunnerFactory({ ...extension, endpoint: { host: "app", port: 0 } } as CaseRunnerFactory)).toThrow("endpoint");
  expect(caseRunnerOutput(runner)).toBe(runner);
  expect(() => caseRunnerOutput({ run: () => { } })).toThrow("invalid runner");
  expect(() => caseRunnerOutput({ ...runner, cleanup: true })).toThrow("invalid runner");
});
