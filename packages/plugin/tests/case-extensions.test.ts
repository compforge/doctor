import { caseExtension } from "./extension-fixture";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, requireCaseRunnerCreateExtension, caseRunnerOutput,
  type CaseRunnerCreateExtension, type ServiceDefinition
} from "../src";
const cases = { caseset: "chat", schema_version: 1 as const, facets: {}, cases: [{ id: "hello", input: { query: "hello" } }] };
const runner = { run: async () => ({ status: 200, durationMs: 1 }), classify: () => ({ ok: true }) };
const extension: CaseRunnerCreateExtension = { id: "runner", kind: "case.runner.create", access: {}, endpoint: { host: "app", port: 8080 }, caseSets: [cases], run: async () => runner };
const base: ServiceDefinition = {
  name: "app",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};

test("Case adaptation preserves metadata and never constructs a runner during discovery", async () => {
  const createRunner = mock(async () => runner);
  const service = {
    ...base,
    extensions: [caseExtension({ endpoint: extension.endpoint, access: {}, caseSets: [cases], createRunner })]
  };
  const catalog = createServiceCatalog([service]);
  const declared = requireCaseRunnerCreateExtension(catalog.extensions("case.runner.create")[0]!.extension);
  expect(declared.caseSets).toEqual([cases]);
  expect(createRunner).not.toHaveBeenCalled();
  const options = { caseSetId: "chat", timeoutMs: 1000 };
  expect(await declared.run({} as never, options)).toBe(runner);
  expect(createRunner).toHaveBeenCalledTimes(1);
  expect(() => createServiceCatalog([{ ...service, extensions: [extension, extension] }])).toThrow("duplicate");
});

test("Case metadata and returned runner are checked at the seam", () => {
  expect(requireCaseRunnerCreateExtension(extension)).toBe(extension);
  expect(() => requireCaseRunnerCreateExtension({ ...extension, caseSets: [] } as CaseRunnerCreateExtension)).toThrow("empty");
  expect(() => requireCaseRunnerCreateExtension({ ...extension, caseSets: [cases, cases] } as CaseRunnerCreateExtension)).toThrow("duplicate");
  expect(() => requireCaseRunnerCreateExtension({ ...extension, endpoint: { host: "app", port: 0 } } as CaseRunnerCreateExtension)).toThrow("endpoint");
  expect(caseRunnerOutput(runner)).toBe(runner);
  expect(() => caseRunnerOutput({ run: () => { } })).toThrow("invalid runner");
  expect(() => caseRunnerOutput({ ...runner, cleanup: true })).toThrow("invalid runner");
});
