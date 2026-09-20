import { expect, mock, test } from "bun:test";
import { createServiceCatalog, defineObservation, defineServiceWorkloadProbe, defineWorkloadProbeExtension,
  requireWorkloadProbeExtension, Type, type ServiceDefinition } from "../src";
const produces = defineObservation({ kind: "health", schemaVersion: 1, schema: Type.Object({ ready: Type.Boolean() }, { additionalProperties: false }) });
const service: ServiceDefinition = { name: "app", component: { name: "test", repository: { forge: { name: "test" }, path: "test" } }, workloads: [], capabilities: {} };
const native = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: async () => ({ ready: true }) });

test("multiple legacy workload probes adapt independently without invocation", () => {
  const probe = mock(async () => ({ ready: true }));
  const first = defineServiceWorkloadProbe({ id: "health", kind: "workload", schemaVersion: 1, workload: "main", produces, access: {}, probe });
  const catalog = createServiceCatalog([{ ...service, contributions: { probes: [first, { ...first, id: "health-2" }] } }]);
  expect(catalog.extensions("workload.probe").map(item => item.extension.id)).toEqual(["health", "health-2"]);
  expect(probe).not.toHaveBeenCalled();
  expect(() => createServiceCatalog([{ ...service, extensions: [native], contributions: { probes: [first] } }])).toThrow("not both");
});

test("workload extension preserves schema types and checks discovery metadata", () => {
  expect(requireWorkloadProbeExtension(native).produces).toBe(produces);
  const missing = { ...native, workload: "" };
  expect(() => requireWorkloadProbeExtension(missing)).toThrow("workload");
  const invalid = { ...native, produces: { ...produces, schemaVersion: 0 } };
  expect(() => requireWorkloadProbeExtension(invalid)).toThrow("Observation");
});
