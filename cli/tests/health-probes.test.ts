import { expect, test, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { createServiceCatalog, defineWorkloadProbeExtension, defineObservation, kubernetesServiceWorkload, withSummary,
  type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import { healthScopes, validateDownstreams } from "../src/health/probes";
import * as probes from "../src/health/probes";
import * as targets from "../src/command/kubernetes-target";

const value = () => ({ summary: () => ({ title: "Startup", fields: [] }) });
const probe = defineWorkloadProbeExtension({ id: "startup", kind: "workload.probe", health: "self", workload: "main", access: {},
  produces: defineObservation({ kind: "startup", schemaVersion: 1, codec: { encode: () => ({}), decode: value } }),
  run: async () => ({ status: "ok", value: value() }) });
const api: ServiceDefinition = { name: "api", workloads: [kubernetesServiceWorkload("api")], extensions: [probe],
  component: { name: "api", repository: { forge: { name: "fixture" }, path: "fixture/api" } } };

test("health discovers opted-in Probes without Cases; unmarked workload probes stay Collect-only", () => {
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([api]) };
  expect(healthProviders(plugin)[0]!.probes).toEqual([probe]);
  expect(() => healthProviders({ ...plugin, services: createServiceCatalog([{ ...api, extensions: [{ ...probe, health: undefined }] }]) })).toThrow("没有支持 health");
  expect(() => healthProviders({ ...plugin, services: createServiceCatalog([{ ...api, extensions: [{ ...probe, namespace: "plugin/fixture" }] }]) })).toThrow("没有支持 health");
  expect(healthScopes("biz")).toEqual(["business"]);
  expect(healthScopes()).toEqual(["self", "deps", "business"]);
  expect(healthScopes("deps,self,self")).toEqual(["deps", "self"]);
  expect(() => healthScopes("deps,unknown")).toThrow("--scope");
});

test("downstream validation rejects undeclared services, duplicate relations and credential-bearing endpoints", () => {
  const dependency = { id: "store", service: "api", workload: "main", endpoint: { host: "storage.demo", port: 9000 } };
  validateDownstreams(api, [api], [dependency]);
  for (const values of [[dependency, dependency], [{ ...dependency, service: "missing" }], [{ ...dependency, endpoint: { host: "user:secret@host", port: 80 } }]]) {
    expect(() => validateDownstreams(api, [api], values)).toThrow("service.downstreams");
  }
});

test("self-only command skips business binding/identity and persists Probe evidence", async () => {
  let businessCalled = false;
  const service: ServiceDefinition = { ...api, extensions: [probe, { id: "cases", kind: "health.case.bindings", access: {},
    run: withSummary({ title: "Must not run", fields: [] }, async () => { businessCalled = true; throw new Error("business should not run"); }) }] };
  const context = new CommandContext({}, undefined, { plugin: { id: "fixture", version: "1", services: createServiceCatalog([service]) } });
  context.ensureEnvironment = async () => {};
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture", kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({ run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }), exec: async () => { throw new Error("unexpected exec"); } });
  const checks = spyOn(probes, "checkHealthProbes").mockImplementation(async provider => {
    expect(provider.probes).toEqual([probe]);
    return [{ probe: "startup", scope: "self", status: "unavailable", reason: "no instances", observations: [], findings: [] }];
  });
  try {
    const result = await healthCommand.run(context, { since: "1h", services: ["api"], scope: "self" });
    expect(businessCalled).toBe(false);
    expect(result.status).toBe(CommandStatus.Failed);
    expect(result.output?.providers[0]!.probes?.[0]?.reason).toBe("no instances");
  } finally {
    checks.mockRestore(); config.mockRestore(); executor.mockRestore(); await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
  }
});
