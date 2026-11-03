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
const native = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: async () => ({ value: new HealthValue(true), status: "ok" as const }) });

test("multiple workload extensions register independently without invocation", () => {
  const probe = mock(async () => ({ value: new HealthValue(true), status: "ok" as const }));
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

test("incomplete workload results retain typed data and require an execution reason", async () => {
  const value = new HealthValue(false);
  const partial = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {},
    run: async () => ({ value, status: "partial", reason: "configuration read denied" }),
  });
  const result = await partial.run({} as never, {} as never);
  expect(result.data.value).toBe(value);
  expect(result.data).toMatchObject({ status: "partial", reason: "configuration read denied" });
  const malformed = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {},
    run: async () => ({ value, status: "unavailable", reason: "" }),
  });
  await expect(malformed.run({} as never, {} as never)).rejects.toThrow("incomplete results require a reason");
});
