import { expect, mock, test } from "bun:test";
import { createServiceCatalog, describeService, validateResourceSnapshot, withSummary,
  type ServiceDefinition, type ServiceResourceDefinition, type ResourceSnapshot, type JsonObject } from "../src";

const resource = { id: "shared-volumes", kind: "volume", name: "Volumes" };
const observe = { access: {}, run: mock(withSummary({ title: "Volumes", fields: [] }, async () => snapshot())) };
const binding: ServiceResourceDefinition = { resource, relationship: "uses", observe };
const service: ServiceDefinition = { name: "worker", aliases: ["w"], workloads: [], resources: [binding],
  component: { name: "worker", repository: { forge: { name: "test" }, path: "worker" } } };
const query = { maxInstances: 2, maxBytes: 4096, timeoutMs: 1000 };
function snapshot(): ResourceSnapshot<JsonObject> {
  return { resource, environment: "test", source: "fixture", observedAt: "2026-10-23T00:00:00Z", scope: { tenant: "one" },
    coverage: { status: "partial", reason: "First page" }, totalCount: 17,
    instances: [{ ref: { environment: "test", resource: resource.id, id: "v1" }, state: "Bound" }], nextCursor: "next" };
}
const check = (value: ResourceSnapshot<JsonObject>) => validateResourceSnapshot(value, { resource, environment: "test" }, query);

test("Resource catalog is offline, preserves Service association and exposes open kind", () => {
  const catalog = createServiceCatalog([service, { ...service, aliases: [], name: "api" }]);
  expect(catalog.resourceSources()).toHaveLength(2);
  expect(catalog.find("w")).toBe(service);
  expect(describeService(service).resources).toEqual([{ resource, relationship: "uses" }]);
  expect(describeService(service).details.access[0]?.owner).toBe("resources.shared-volumes.observe");
  expect(observe.run).not.toHaveBeenCalled();
  expect(catalog.extensions("resource.observe")).toEqual([]);
  expect(() => createServiceCatalog([{ ...service, resources: [binding, binding] }])).toThrow("duplicate Resource");
  expect(() => createServiceCatalog([{ ...service, resources: [{ ...binding, resource: { ...resource, kind: "" } }] }])).toThrow("kind");
});

test("Resource snapshot keeps independent total, page coverage and unknown values", () => {
  expect(() => check(snapshot())).not.toThrow();
  const unavailable = { ...snapshot(), totalCount: undefined, instances: undefined, nextCursor: undefined,
    coverage: { status: "unavailable" as const, reason: "No permission" } };
  expect(() => check(unavailable)).not.toThrow();
  expect(unavailable.totalCount).toBeUndefined();
  expect(() => check({ ...snapshot(), coverage: { status: "complete" } })).toThrow("partial coverage");
});

test("Resource boundary rejects wrong identity, invalid totals, duplicate instances and budgets", () => {
  expect(() => check({ ...snapshot(), environment: "other" })).toThrow("identity");
  expect(() => check({ ...snapshot(), resource: { ...resource, kind: "bed" } })).toThrow("identity");
  expect(() => check({ ...snapshot(), totalCount: -1 })).toThrow("totalCount");
  expect(() => check({ ...snapshot(), instances: [snapshot().instances![0]!, snapshot().instances![0]!] })).toThrow("duplicate");
  expect(() => check({ ...snapshot(), instances: Array(3).fill(snapshot().instances![0]) })).toThrow("budget");
  expect(() => check({ ...snapshot(), source: "x".repeat(4096) })).toThrow("byte budget");
  expect(() => check({ ...snapshot(), measurements: [{ name: "size", value: NaN, unit: "byte", scope: "total" }] })).toThrow("measurement");
});

test("Same collection identity must retain its kind across Services", () => {
  expect(() => createServiceCatalog([service, { ...service, name: "api", aliases: [], resources: [{ ...binding,
    resource: { ...resource, kind: "bed" } }] }])).toThrow("Conflicting kind");
});
