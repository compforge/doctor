import { inspectExtension } from "./extension-fixture";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, describeService, FACTS_INSPECT_KIND, requireFactsInspectExtension,
  type Extension, type FactsInspectExtension, type ServiceDefinition
} from "../src";

const service = (extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({
  name: "records",
  component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } },
  workloads: [],
  extensions
});

test("Catalog discovers multiple open kinds without invoking them or imposing a global input/output map", () => {
  const run = mock(async () => ["worker"]);
  const data: Extension<void, string[]> = { id: "workloads", kind: "workload.describe", access: {}, run };
  const inspect: FactsInspectExtension = {
    id: "records", kind: FACTS_INSPECT_KIND, access: {},
    accepts: ["biz_id"], provides: ["record"], run: async () => []
  };
  const declared = service([data, inspect]);
  const catalog = createServiceCatalog([declared]);
  expect(catalog.extensions("workload.describe")[0]?.extension).toBe(data);
  expect(catalog.extensions(FACTS_INSPECT_KIND)[0]?.service).toBe(declared);
  expect(requireFactsInspectExtension(catalog.extensions(FACTS_INSPECT_KIND)[0]!.extension)).toBe(inspect);
  expect(catalog.extensions("private.future-kind")).toEqual([]);
  const description = describeService(declared);
  expect(description.extensions?.map(item => item.kind)).toEqual(["workload.describe", FACTS_INSPECT_KIND]);
  expect(description.details.access.map(item => item.owner)).toEqual(["extensions.workloads", "extensions.records"]);
  expect(JSON.stringify(description)).not.toContain('"run"');
  expect(run).not.toHaveBeenCalled();
});

test("Catalog rejects malformed common declarations and duplicate IDs; the domain validates its own metadata", () => {
  const item = { id: "one", kind: "custom.kind", access: {}, run: async () => 1 };
  expect(() => createServiceCatalog([service([item, item])])).toThrow("duplicate Extension id");
  expect(() => createServiceCatalog([service([{ ...item, access: undefined } as never])])).toThrow("Extension.access");
  expect(() => createServiceCatalog([service([{ ...item, run: undefined } as never])])).toThrow("Extension.run");
  expect(() => requireFactsInspectExtension({ ...item, kind: FACTS_INSPECT_KIND })).toThrow("accepts");
});

test("Inspect adaptation has one source of truth and cannot coexist with a second facts.inspect declaration", () => {
  const inspect = {
    access: {}, accepts: ["biz_id"], provides: ["record"],
    resolveTarget: mock(async () => ({ endpoint: "", database: "", username: "", credentialSource: "" })),
    inspect: mock(async () => [])
  };
  const declared = {
    ...service([]),
    extensions: [inspectExtension(inspect)]
  };
  const catalog = createServiceCatalog([declared]);
  const extension = requireFactsInspectExtension(catalog.extensions(FACTS_INSPECT_KIND)[0]!.extension);
  expect(extension.id).toBe("inspect");
  expect(extension.access).toBe(inspect.access);
  expect(inspect.inspect).not.toHaveBeenCalled();
  expect(inspect.resolveTarget).not.toHaveBeenCalled();
  expect(() => createServiceCatalog([{ ...declared, extensions: [extension, extension] }])).toThrow("duplicate");
});
