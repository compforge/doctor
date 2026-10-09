import { expect, mock, test } from "bun:test";
import { caseSetFromRaw } from "@compforge/spec-case/model";
import { caseProducer, caseRunner, createServiceCatalog, describeService, loadCaseCatalog, withSummary,
  type ServiceCaseSource, type ServiceDefinition } from "../src";

const base: ServiceDefinition = { name: "catalog", aliases: ["short"], workloads: [],
  component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } } };
const caseSet = { caseset: "shared", schema_version: 1 as const, cases: [{ id: "ping", input: { method: "GET", path: "/" } }] };

test("Service discovery and description never load assets or prepare runtime objects", () => {
  const load = mock(() => [caseSet]);
  const run = mock(withSummary({ title: "Cases", fields: [] }, async () => ({ cases: [], reason: "No sample" })));
  const source: ServiceCaseSource = { id: "requests", load, produce: { access: {}, run } };
  const service = { ...base, cases: [source] };
  const catalog = createServiceCatalog([service]);
  expect(catalog.caseSource({ service: "short", source: "requests" })).toEqual({ service, source });
  expect(describeService(service).cases).toEqual([{ id: "requests", description: undefined, produce: true, runner: false }]);
  expect(load).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(loadCaseCatalog(source)).toEqual([caseSetFromRaw(caseSet)]);
  expect(load).toHaveBeenCalledTimes(1);
  expect(caseProducer(source).run).toBe(run);
  expect(caseProducer(source)).toBe(source.produce!);
  for (const key of ["id", "kind", "namespace"]) expect(caseProducer(source)).not.toHaveProperty(key);
  expect(run).not.toHaveBeenCalled();
});

test("one Case resource contributes independent native operations without another registration", () => {
  const source: ServiceCaseSource = { id: "requests", load: () => [caseSet],
    produce: { access: {}, run: withSummary({ title: "Requests", fields: [] }, async () => ({ cases: [], reason: "fixture" })) },
    runner: { access: {}, endpoint: { host: "app", port: 80 }, supports: () => true,
      run: withSummary({ title: "Runner", fields: [] }, async () => ({ run: async () => ({ status: 200, durationMs: 1 }), classify: () => ({ ok: true }) })) },
  };
  const catalog = createServiceCatalog([{ ...base, cases: [source] }]);
  expect(catalog.extensions("case.produce")).toEqual([]);
  expect(catalog.extensions("case.runner.create")).toEqual([]);
  expect(catalog.caseSources()[0]!.source).toBe(source);
  expect(caseRunner(source)).toBe(source.runner!);
  for (const key of ["id", "kind", "namespace"]) expect(caseRunner(source)).not.toHaveProperty(key);
  expect(describeService({ ...base, cases: [source] }).cases?.[0]).toMatchObject({ id: "requests", produce: true, runner: true });
});

test("Case references require a specific owning Service and source", () => {
  const source = { id: "requests", load: () => [caseSet] };
  const catalog = createServiceCatalog([{ ...base, cases: [source] }]);
  expect(() => catalog.caseSource({ service: "missing", source: "requests" })).toThrow("Missing Service Case source");
  expect(() => catalog.caseSource({ service: "catalog", source: "missing" })).toThrow("Missing Service Case source");
  expect(() => catalog.caseSource({ service: "", source: "requests" })).toThrow("service and source");
  expect(() => createServiceCatalog([{ ...base, cases: [source, source] }])).toThrow("duplicate Case source");
  expect(() => caseProducer(source)).toThrow("does not provide runtime Cases");
});

test("Case assets have one registration path and runner compatibility is explicit", () => {
  for (const kind of ["case.catalog", "case.produce", "case.runner.create", "case.consume"]) {
    expect(() => createServiceCatalog([{ ...base, extensions: [{ id: "legacy", kind, access: {},
      run: withSummary({ title: "Legacy", fields: [] }, async () => undefined) }] }])).toThrow("Service.cases");
  }
  expect(() => createServiceCatalog([{ ...base, cases: [{ id: "requests", load: () => [caseSet], runner: {
    access: {}, endpoint: { host: "service", port: 80 },
    run: withSummary({ title: "Runner", fields: [] }, async () => ({})),
  } as never }] }])).toThrow("supports");
});

test("offline CaseSet normalization rejects duplicate and invalid assets", () => {
  expect(() => loadCaseCatalog({ id: "source", load: () => [caseSet, caseSet] })).toThrow("duplicate");
  expect(() => loadCaseCatalog({ id: "source", load: () => [{ ...caseSet, cases: [] }] })).toThrow("empty");
  expect(() => loadCaseCatalog({ id: "source", load: () => [{ ...caseSet, cases: [{ id: "ping", input: {}, facets: { unknown: "value" } }] }] })).toThrow("unknown facet");
});
