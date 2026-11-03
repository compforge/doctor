import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, defineObservation, defineWorkloadProbeExtension,
  requireWorkloadProbeExtension, type ServiceDefinition
} from "../src";
class HealthValue {
  constructor(readonly ready: boolean) {}
  summary() { return { title: "Health", fields: [] }; }
}
const produces = defineObservation({ kind: "health", schemaVersion: 1, codec: {
  encode: (value: HealthValue) => ({ ready: value.ready }),
  decode: (json: unknown) => {
    if (!json || typeof json !== "object" || !("ready" in json) || typeof json.ready !== "boolean") throw new Error("invalid health");
    return new HealthValue(json.ready);
  },
} });
const service: ServiceDefinition = {
  name: "app",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};
const native = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: async () => new HealthValue(true) });

test("multiple workload extensions register independently without invocation", () => {
  const probe = mock(async () => new HealthValue(true));
  const first = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: probe });
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

test("workload extension preserves Value types and checks discovery metadata", () => {
  expect(requireWorkloadProbeExtension(native).produces).toBe(produces);
  const missing = { ...native, workload: "" };
  expect(() => requireWorkloadProbeExtension(missing)).toThrow("workload");
  const invalid = { ...native, produces: { ...produces, schemaVersion: 0 } };
  expect(() => requireWorkloadProbeExtension(invalid)).toThrow("Observation");
});
