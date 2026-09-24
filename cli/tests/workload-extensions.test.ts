import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, defineObservation, defineWorkloadProbeExtension, Type, type ServiceDefinition } from "@compforge/doctor-plugin";
import { workloadProbeProviders } from "../src/plugin/workload-extensions";
const produces = defineObservation({ kind: "health", schemaVersion: 1, schema: Type.Object({ ready: Type.Boolean() }, { additionalProperties: false }) });
const service: ServiceDefinition = {
  name: "app",
  aliases: ["api"],
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: [{ name: "main", platform: "kubernetes", location: { kind: "service", name: "app" } }]
};
const extension = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: withSummary({ title: "Probe", fields: [] }, async () => ({ ready: true })) });

test("workload discovery preserves separate probe permissions without calling providers", () => {
  const run = mock(extension.run);
  const access = { kubernetes: [{ rule: { verb: "get", resource: "pods" }, requirement: "required", purpose: "inspect pod" }] } as const;
  const catalog = createServiceCatalog([{ ...service, extensions: [{ ...extension, run }, { ...extension, id: "details", access }] }]);
  const selected = workloadProbeProviders(catalog, "api");
  expect(selected.map(item => item.extension.id)).toEqual(["health", "details"]);
  expect(selected[0]!.extension.access).toEqual({});
  expect(selected[1]!.extension.access).toBe(access);
  expect(run).not.toHaveBeenCalled();
  expect(workloadProbeProviders(catalog, "missing")).toEqual([]);
});

test("workload references and Observation schemas are checked before scheduling", () => {
  const unknown = createServiceCatalog([{ ...service, extensions: [{ ...extension, workload: "missing" }] }]);
  expect(() => workloadProbeProviders(unknown)).toThrow("unknown Workload");
  const invalid = createServiceCatalog([{ ...service, extensions: [{ ...extension, produces: { ...produces, schema: { type: "object", properties: { ready: { type: "not-a-type" } } } } }] }]);
  expect(() => workloadProbeProviders(invalid)).toThrow();
});
