import { expect, test, spyOn } from "bun:test";
import { createServiceCatalog, defineEndpointProbeExtension, defineObservation, kubernetesServiceWorkload,
  type PluginContext, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext } from "../src/command";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { checkDependencyHealthProbes } from "../src/health/deps/probes";
import * as workloads from "../src/health/workloads";
import * as runtime from "../src/health/runtime";

const workload = kubernetesServiceWorkload("worker", { name: "inline", container: "server" });
const observation = defineObservation({ kind: "custom-connectivity", schemaVersion: 1,
  codec: { encode: () => ({ connected: true }), decode: () => ({ summary: () => ({ title: "Custom connectivity", fields: [] }) }) } });
const service: ServiceDefinition = { name: "worker", workloads: [],
  component: { name: "worker", repository: { forge: { name: "fixture" }, path: "fixture/worker" } } };

for (const mode of ["ok", "failure", "cancelled"] as const) {
  test(`independent endpoint.probe runs without endpoints and retains ${mode} evidence`, async () => {
    const calls: string[] = [];
    const extension = defineEndpointProbeExtension({ id: "custom", kind: "endpoint.probe", workload, access: {}, produces: observation,
      run: async (plugin, input) => {
        expect(plugin.signal).toBe(context.signal);
        expect(input.instance.workload).toBe("inline");
        calls.push(input.instance.pod);
        if (mode === "failure") throw new Error("custom failure");
        if (mode === "cancelled") { context.cancel(); plugin.signal.throwIfAborted(); }
        return { status: "ok", value: observation.codec.decode({}) };
      } });
    const plugin = { id: "fixture", version: "1", services: createServiceCatalog([{ ...service, extensions: [extension] }]) };
    const context = new CommandContext({}, undefined, { plugin });
    const discovered = spyOn(workloads, "discoverHealthWorkload").mockImplementation(async declared => {
      expect(declared).toBe(workload);
      return { definition: declared, pods: [], instances: [{ platform: "kubernetes", environment: "fixture", namespace: "demo",
        workload: declared.name, pod: "worker-0", uid: "uid", container: "server" }] };
    });
    const invocation = spyOn(runtime, "caseOperationInvoker").mockReturnValue(async (_service, operation, input) => {
      expect(Object.is(operation, extension)).toBe(true);
      return (await operation.run({ signal: context.signal } as PluginContext, input)).data;
    });
    try {
      const providers = healthProviders(plugin);
      expect(providers[0]!.endpoints).toBeUndefined();
      const actions = { signal: context.signal, probes: (provider: typeof providers[number]) => checkDependencyHealthProbes(provider, context, {} as Executor, { namespace: "demo" }),
        endpoints: async () => { throw new Error("no generic fallback or inferred Endpoint"); }, cases: async () => [], show: () => {} };
      await runHealthSession(providers, {}, { ...actions, scopes: ["self"] });
      expect(calls).toEqual([]);
      const result = await runHealthSession(providers, {}, { ...actions, scopes: ["deps"] });
      expect(calls).toEqual(["worker-0"]);
      const check = result.providers[0]!.probes![0]!;
      expect(check.status).toBe(mode === "failure" ? "unavailable" : mode);
      expect(check.observations).toHaveLength(mode === "ok" ? 1 : 0);
      if (mode === "ok") expect(check.observations[0]).toMatchObject({ workload: "inline", value: { connected: true } });
    } finally { invocation.mockRestore(); discovered.mockRestore(); await context.disposeClients(); }
  });
}

test("Core schedules both contribution lists without matching addresses or ids", async () => {
  const extension = defineEndpointProbeExtension({ id: "same-label", kind: "endpoint.probe", workload, access: {}, produces: observation,
    run: async () => ({ status: "ok", value: observation.codec.decode({}) }) });
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([{ ...service,
    endpoints: [{ id: "same-label", workload, host: "storage.example", port: 80 }], extensions: [extension] }]) };
  const calls: string[] = [];
  await runHealthSession(healthProviders(plugin), {}, { scopes: ["deps"],
    probes: async provider => { expect(provider.endpointProbes).toEqual([extension]); calls.push("custom"); return []; },
    endpoints: async () => { calls.push("generic"); return []; }, cases: async () => [], show: () => {} });
  expect(calls).toEqual(["custom", "generic"]);
});

test("endpoint.probe declarations validate Workload and Observation without executing", () => {
  const extension = defineEndpointProbeExtension({ id: "custom", kind: "endpoint.probe", workload, access: {}, produces: observation,
    run: async () => { throw new Error("must not execute discovery"); } });
  expect(() => createServiceCatalog([{ ...service, extensions: [extension] }])).not.toThrow();
  expect(() => createServiceCatalog([{ ...service, extensions: [{ ...extension, workload: "inline" as never }] }])).toThrow("Workload");
  expect(() => createServiceCatalog([{ ...service, extensions: [{ ...extension, produces: {} as never }] }])).toThrow("Observation");
});
