import { expect, test } from "bun:test";
import { createServiceCatalog, describeService, type ServiceDefinition } from "@compforge/doctor-plugin";
import { parseInspectServices } from "../src/collect/inspect/options";
import { parseDataServices } from "../src/collect/data/config";
import { resolveLogServices } from "../src/collect/log/config";
import { parseMetricServices } from "../src/collect/metric/config";
import { validatePluginDefinition } from "../src/plugin/definition";
import type { PluginManifest } from "../src/plugin/manifest";
import { formatServiceDescription } from "../src/app/plugin-description";

const service: ServiceDefinition = { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
  name: "api-server", aliases: ["api"], workloads: [],
  capabilities: {
    log: { default: true },
    metric: { endpoint: { host: "api-server", port: 80, path: "/metrics" }, metricNames: [], charts: [] },
  },
  contributions: { inspect: {
    access: {}, accepts: ["biz_id"], provides: ["record"],
    resolveTarget: async () => { throw new Error("offline"); },
    inspect: async () => { throw new Error("offline"); },
  } },
};
const catalog = createServiceCatalog([service]);

for (const [name, parse] of Object.entries({ inspect: parseInspectServices, data: parseDataServices, log: resolveLogServices, metric: parseMetricServices })) {
  test(`${name} canonicalizes aliases and schedules a Service only once`, () => {
    expect(parse("api,api-server,api", catalog)).toEqual(["api-server"]);
    expect(() => parse("missing", catalog)).toThrow();
  });
}

test("alias resolution retains contribution checks and self-description", () => {
  expect(catalog.findWithContribution("api", "inspect")?.name).toBe("api-server");
  const description = describeService(service);
  expect(description.aliases).toEqual(["api"]);
  expect(formatServiceDescription(description)).toContain("Aliases：api");
  expect(() => parseDataServices("api", createServiceCatalog([{ ...service, contributions: undefined }]))).toThrow("facts.inspect Extension");
});

test("runtime Plugin loading validates aliases and reconstructs the alias-aware Catalog", () => {
  const manifest = { id: "sample", version: "1.0.0" } as PluginManifest;
  const load = (aliases: unknown) => validatePluginDefinition({
    id: "sample", version: "1.0.0", services: { services: [{ ...service, aliases }] },
  }, manifest);
  expect(load(["api"]).services.find("api")?.name).toBe("api-server");
  for (const aliases of ["api", [42], [""], ["api", "api"], ["api-server"]]) {
    expect(() => load(aliases)).toThrow();
  }
});
