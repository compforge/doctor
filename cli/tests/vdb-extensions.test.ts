import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type ServiceDefinition, type VdbTargetInspectExtension } from "@compforge/doctor-plugin";
import { vdbTargetProviders, vdbTargetProvider, inspectVdbTarget } from "../src/datasource/vdb-extension";
import { createHostPluginContext } from "../src/plugin/context";
const target = { backend: "opensearch", store: "trace", configurationKind: "plugin" };
const extension: VdbTargetInspectExtension = { id: "trace-target", kind: "datasource.vdb.inspect", dataSource: "trace", access: {}, run: withSummary({"title":"向量数据库","fields":[{"label":"类型","path":["kind"]}]}, async () => target) };
const service: ServiceDefinition = {
  name: "search",
  aliases: ["trace-search"],
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: [],
  dataSources: [{ id: "trace", kind: "vdb", backend: "opensearch" }, { id: "business", kind: "vdb", backend: "opensearch" }]
};

test("VDB providers are selected by Service alias and data source without invocation", () => {
  const run = mock(extension.run);
  const catalog = createServiceCatalog([{ ...service, extensions: [{ ...extension, run }, { ...extension, id: "business-target", dataSource: "business" }] }]);
  expect(vdbTargetProvider(catalog, "trace-search", "trace")?.extension.id).toBe("trace-target");
  expect(vdbTargetProvider(catalog, "search", "business")?.extension.id).toBe("business-target");
  expect(vdbTargetProvider(catalog, "search", "missing")).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
});

test("VDB provider discovery rejects dangling references, ambiguity and shared Client conflicts", () => {
  expect(() => vdbTargetProviders(createServiceCatalog([{ ...service, extensions: [{ ...extension, dataSource: "missing" }] }]))).toThrow("unknown VDB");
  expect(() => vdbTargetProviders(createServiceCatalog([{ ...service, extensions: [extension, { ...extension, id: "duplicate" }] }]))).toThrow("ambiguous");
  const shared = {
    ...service,
    dataSources: [{ id: "trace", kind: "vdb", backend: "opensearch", source: { clientKey: "trace", createClient: () => { throw new Error("not called"); } } }]
  } as const;
  expect(() => vdbTargetProviders(createServiceCatalog([{ ...shared, extensions: [extension] }]))).toThrow("shared Client");
});

test("target inspection releases scope after success, invalid output and provider failure", async () => {
  for (const outcome of ["success", "invalid", "failure"] as const) {
    const cleanup = mock(() => { });
    const provider: VdbTargetInspectExtension = {
      ...extension, run: withSummary({ title: "Fixture", fields: [] }, async context => {
        context.onDispose(cleanup);
        if (outcome === "failure") throw new Error("provider failed");
        return outcome === "invalid" ? { ...target, backend: "" } : target;
      })
    };
    const pending = inspectVdbTarget(provider, async () => createHostPluginContext({ service, capability: provider }));
    if (outcome === "success") expect(await pending).toEqual(target);
    else await expect(pending).rejects.toThrow(outcome === "invalid" ? "identity" : "provider failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
  }
});

test("access denial prevents VDB provider execution", async () => {
  const run = mock(extension.run);
  await expect(inspectVdbTarget({ ...extension, run }, async () => { throw new Error("access denied"); })).rejects.toThrow("access denied");
  expect(run).not.toHaveBeenCalled();
});
