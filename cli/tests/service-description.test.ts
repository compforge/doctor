import { expect, test } from "bun:test";
import { createServiceCatalog, describeService, type ServiceDefinition } from "@compforge/doctor-plugin";
import { validatePluginDefinition } from "../src/plugin/definition";
import type { PluginManifest } from "../src/plugin/manifest";
import { formatServiceDescription } from "../src/app/plugin-description";

const service: ServiceDefinition = { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
  name: "api", description: "Business API", workloads: [], capabilities: {},
  contributions: { inspect: {
    description: "Read a request record", limitations: ["Retained records only"],
    access: {}, accepts: ["request_id"], provides: ["request-record"], expands: ["run_id"],
    inspect: async () => { throw new Error("offline"); },
  } },
};
const manifest: PluginManifest = {
  manifestVersion: 1, pluginApiVersion: 1, id: "sample", version: "1.0.0",
  requiresDoctor: ">=0.1.0", contentDigest: "test", main: "./plugin.mjs", skills: [],
};

function validate(candidate: unknown) {
  return validatePluginDefinition({ id: "sample", version: "1.0.0", services: { services: [candidate] } }, manifest);
}

test("Plugin loading validates optional description fields without executing them", () => {
  expect(validate(service).services.find("api")?.description).toBe("Business API");
  expect(validate({ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "legacy", workloads: [], capabilities: {} }).services.find("legacy")).toBeDefined();
  expect(() => validate({ ...service, description: 42 })).toThrow("api.description");
  expect(() => validate({ ...service, description: " " })).toThrow("api.description");
  for (const [field, value] of [["description", ""], ["description", {}], ["limitations", "text"], ["limitations", [42]], ["limitations", [""]]] as const) {
    expect(() => validate({ ...service, contributions: { inspect: {
      ...service.contributions!.inspect!, [field]: value,
    } } })).toThrow(`api.contributions.inspect.${field}`);
  }
  expect(validate({ ...service, contributions: { inspect: {
    ...service.contributions!.inspect!, limitations: [],
  } } }).services.find("api")).toBeDefined();
});

test("text uses the same projection and distinguishes possible output from accepted input", () => {
  const catalog = createServiceCatalog([service]);
  const text = formatServiceDescription(describeService(catalog.find("api")!));
  expect(text).toContain("说明：Business API");
  expect(text).toContain("用途：Read a request record");
  expect(text).toContain("输入 ID（每个 Query 选一种）：request_id");
  expect(text).toContain("可能关联的 ID：run_id");
  expect(text).toContain("可能提供的事实：request-record");
  expect(text).toContain("限制说明：Retained records only");
  expect(text).toContain("尚未检查目标环境");
  expect(text).not.toContain("输入 ID（每个 Query 选一种）：run_id");
});

test("Workload explanation appears in offline Service text and JSON projection", () => {
  const described = describeService({ ...service, workloads: [{
    name: "worker", description: "Handles session runs", platform: "kubernetes",
    location: { kind: "service", name: "worker-service" },
  }] });
  expect(described.details.workloads[0]?.description).toBe("Handles session runs");
  expect(formatServiceDescription(described)).toContain("worker: service/worker-service — Handles session runs");
  expect(() => validate({ ...service, workloads: [{
    name: "worker", description: " ", platform: "kubernetes", location: { kind: "service", name: "worker-service" },
  }] })).toThrow("api.workloads.worker.description");
});

test("text distinguishes absent declarations and absent explanatory prose", () => {
  const legacy = formatServiceDescription(describeService({ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "legacy", workloads: [], capabilities: {} }));
  expect(legacy).toContain("说明：未提供");
  expect(legacy).toContain("未声明 Inspect contribution");
  expect(legacy).toContain("Capabilities：无");
  const missing = formatServiceDescription(describeService({ ...service, contributions: { inspect: {
    ...service.contributions!.inspect!, description: undefined, limitations: undefined,
  } } }));
  expect(missing).toContain("用途：未提供");
  expect(missing).toContain("未提供（不代表无限制）");
});

test("text reports VDB access under its Store identity", () => {
  const text = formatServiceDescription(describeService({ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "search", workloads: [], capabilities: {
    dataSources: [{ id: "index", kind: "vdb", backend: "opensearch", access: { kubernetes: [{
      rule: { verb: "get", resource: "configmaps", resourceName: "search-config" },
      requirement: "required", purpose: "Locate search storage",
    }] } }],
  } }));
  expect(text).toContain("capabilities.dataSources.index:");
  expect(text).toContain("required: get configmaps/search-config — Locate search storage");
});
