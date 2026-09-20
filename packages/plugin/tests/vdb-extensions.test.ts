import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, requireVdbTargetInspectExtension, vdbTargetOutput,
  type ServiceDefinition, type VdbTargetInspectExtension
} from "../src";
const target = { backend: "opensearch", store: "trace", endpoint: "http://search:9200", configurationKind: "plugin" };
const service: ServiceDefinition = {
  name: "search",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};
const extension: VdbTargetInspectExtension = { id: "trace-target", kind: "datasource.vdb.inspect", dataSource: "trace", access: {}, run: async () => target };

test("VDB adapters remain offline and distinguish each data source", async () => {
  const inspectTarget = mock(async () => target);
  const trace = { id: "trace", kind: "vdb", backend: "opensearch" } as const;
  const declared = {
    ...service,
    dataSources: [trace, { ...trace, id: "business" }],
    extensions: [{ ...extension, run: inspectTarget }, { ...extension, id: "business-target", dataSource: "business", run: inspectTarget }]
  };
  const catalog = createServiceCatalog([declared]);
  const found = catalog.extensions("datasource.vdb.inspect").map(item => requireVdbTargetInspectExtension(item.extension));
  expect(found.map(item => item.dataSource)).toEqual(["trace", "business"]);
  expect(inspectTarget).not.toHaveBeenCalled();
  expect(await found[0]!.run({} as never, undefined)).toBe(target);
  expect(() => createServiceCatalog([{ ...declared, extensions: [extension, extension] }])).toThrow("duplicate");
});

test("VDB output validation does not disclose credentials", () => {
  expect(vdbTargetOutput(target)).toBe(target);
  expect(() => vdbTargetOutput({ ...target, password: { secret: "do-not-print" } })).toThrow("invalid password");
  try { vdbTargetOutput({ ...target, password: { secret: "do-not-print" } }); }
  catch (error) { expect(String(error)).not.toContain("do-not-print"); }
  expect(() => vdbTargetOutput({ ...target, backend: "" })).toThrow("identity");
  expect(() => vdbTargetOutput({ ...target, source: { pod: 1 } })).toThrow("provenance");
});
