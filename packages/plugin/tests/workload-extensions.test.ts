import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, defineObservation, defineWorkloadProbeExtension,
  requireWorkloadProbeExtension, Type, type ServiceDefinition
} from "../src";
const produces = defineObservation({ kind: "health", schemaVersion: 1, schema: Type.Object({ ready: Type.Boolean() }, { additionalProperties: false }) });
const service: ServiceDefinition = {
  name: "app",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};
const native = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: withSummary({ title: "Probe", fields: [] }, async () => ({ ready: true })) });

test("multiple workload extensions register independently without invocation", () => {
  const probe = mock(async () => ({ ready: true }));
  const first = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: withSummary({ title: "Probe", fields: [] }, probe) });
  const catalog = createServiceCatalog([{
    ...service,
    extensions: [first, { ...first, id: "health-2" }]
  }]);
  expect(catalog.extensions("workload.probe").map(item => item.extension.id)).toEqual(["health", "health-2"]);
  expect(probe).not.toHaveBeenCalled();
  expect(() => createServiceCatalog([{
    ...service,
    extensions: [first, native]
  }])).toThrow("duplicate");
});

test("workload extension preserves schema types and checks discovery metadata", () => {
  expect(requireWorkloadProbeExtension(native).produces).toBe(produces);
  const missing = { ...native, workload: "" };
  expect(() => requireWorkloadProbeExtension(missing)).toThrow("workload");
  const invalid = { ...native, produces: { ...produces, schemaVersion: 0 } };
  expect(() => requireWorkloadProbeExtension(invalid)).toThrow("Observation");
});
