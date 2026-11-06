import { expect, test, spyOn } from "bun:test";
import { createServiceCatalog, defineObservation, defineWorkloadProbeExtension, kubernetesServiceWorkload, type ServiceDefinition, type PluginContext } from "@compforge/doctor-plugin";
import type { Endpoint, WorkloadInstance } from "@compforge/harness-common";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { rmSync } from "node:fs";
import { healthCommand } from "../src/health";
import { CommandStatus } from "../src/command";
import * as endpointChecks from "../src/health/deps/endpoints";
import * as targets from "../src/command/kubernetes-target";
import { CommandContext } from "../src/command";
import { checkHealthEndpoints } from "../src/health/deps/endpoints";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";
import * as workloads from "../src/health/workloads";
import * as runtime from "../src/health/runtime";

const service: ServiceDefinition = { name: "worker", workloads: [kubernetesServiceWorkload("worker")],
  component: { name: "worker", repository: { forge: { name: "fixture" }, path: "fixture/worker" } } };
const endpoint: Endpoint = { id: "download", workload: service.workloads[0]!, scheme: "https", host: "storage.other-namespace", port: 443, secure: true };
const instance = (pod: string): WorkloadInstance => ({ platform: "kubernetes", environment: "fixture", namespace: "demo", workload: "main", pod, uid: pod, container: "worker" });
async function check(endpoints: readonly Endpoint[], options: { pods?: string[]; pending?: string[]; toolError?: boolean; networkFailure?: boolean; missing?: boolean } = {}) {
  const definition = { ...service, endpoints };
  const context = new CommandContext({}, undefined, { plugin: { id: "fixture", version: "1", services: createServiceCatalog([definition]) } });
  const provider = healthProviders(context.plugin)[0]!;
  const commands: Array<{ pod: string; target: unknown }> = [];
  const discovery = spyOn(workloads, "discoverHealthWorkload").mockImplementation(async workload => {
    if (options.missing) throw new Error("no instances");
    return { definition: workload, instances: (options.pods ?? ["worker-0"]).map(instance), pods: (options.pods ?? ["worker-0"]).map(name => ({ name, namespace: "demo", kind: "pod" as const, serviceAccountName: "default", conditions: [], labels: {}, phase: options.pending?.includes(name) ? "Pending" : "Running", containers: [] })) };
  });
  const invoker = spyOn(runtime, "caseOperationInvoker").mockReturnValue(async (owner, operation, input) => {
    expect(owner.name).toBe("worker");
    expect(operation.access.kubernetes).toContainEqual(expect.objectContaining({ rule: { verb: "create", resource: "pods/exec" } }));
    return (await operation.run({ signal: context.signal, infra: { kubernetes: {
      exec: async (target: { pod: string; container?: string }, _command: readonly string[], opts: { stdin: string; timeoutMs: number }) => {
        expect(target.container).toBe("worker"); expect(opts.timeoutMs).toBe(5000);
        commands.push({ pod: target.pod, target: JSON.parse(opts.stdin) });
        if (options.toolError) throw new Error("python unavailable");
        return JSON.stringify(options.networkFailure
          ? { status: "failed", stages: [{ stage: "dns", status: "failed", elapsedMs: 1, error: "gaierror" }] }
          : { status: "passed", stages: ["dns", "tcp", "tls"].map(stage => ({ stage, status: "passed", elapsedMs: 1 })) });
      },
    } } } as unknown as PluginContext, input)).data;
  });
  try {
    const results = await checkHealthEndpoints(provider, context, {} as Executor, { namespace: "demo" });
    return { results, commands, discoveries: discovery.mock.calls.length, declarations: discovery.mock.calls.map(call => call[0]) };
  } finally { discovery.mockRestore(); invoker.mockRestore(); await context.disposeClients(); }
}

test("explicit empty declaration avoids discovery and network execution", async () => {
  const { results, commands, discoveries } = await check([]);
  expect(results).toMatchObject([{ status: "none" }]);
  expect(commands).toEqual([]);
  expect(discoveries).toBe(0);
  expect(buildHealthHtml({ query: {}, providers: [{ name: "worker", namespace: "fixture", endpoints: results }] })).toContain("没有对外 Endpoint 依赖");
});

test("shared consumer discovery is reused and target namespace remains opaque", async () => {
  const { results, commands, discoveries } = await check([endpoint, { ...endpoint, id: "second" }], { pods: ["worker-0", "worker-1"] });
  expect(results.map(item => item.status)).toEqual(["passed", "passed"]);
  expect(discoveries).toBe(1);
  expect(commands[0]).toMatchObject({ pod: "worker-0", target: { host: "storage.other-namespace", tls: true } });
});

test("network failure is observed; tool failure and unsupported protocol are unavailable", async () => {
  expect((await check([endpoint], { networkFailure: true })).results[0]).toMatchObject({ status: "failed", evidence: { status: "failed" } });
  expect((await check([endpoint], { toolError: true })).results[0]).toMatchObject({ status: "unavailable", error: { message: "python unavailable" } });
  const unsupported = await check([{ ...endpoint, scheme: "mysql", host: "db.demo", port: 3306, secure: true }]);
  expect(unsupported.results[0]).toMatchObject({ status: "unavailable", error: { kind: "protocol", code: "Unsupported" } });
  expect(unsupported.commands).toEqual([]);
});

test("missing consumer or instances retain unknown coverage", async () => {
  const missing = await check([{ ...endpoint, workload: undefined }]);
  expect(missing.results[0]!.status).toBe("unavailable");
  expect(missing.discoveries).toBe(0);
  expect((await check([endpoint], { missing: true })).results[0]!.status).toBe("unavailable");
});

test("each Endpoint probes once from its Workload's first Running instance", async () => {
  const sampled = await check([endpoint], { pods: Array.from({ length: 11 }, (_, i) => `worker-${i}`) });
  expect(sampled.commands).toHaveLength(1);
  expect(sampled.results).toHaveLength(1);
  expect(sampled.results[0]).toMatchObject({ status: "passed", instance: { pod: "worker-0" } });
  expect(sampled.results[0]!.reason).toContain("不代表其余副本可达");
});

test("address caps retain every unexecuted Endpoint without discovering its consumer", async () => {
  const endpoints = Array.from({ length: 102 }, (_, i) => ({ ...endpoint, id: `endpoint-${i}`,
    workload: kubernetesServiceWorkload(`consumer-${i}`) }));
  const capped = await check(endpoints);
  expect(capped.commands).toHaveLength(100);
  expect(capped.discoveries).toBe(100);
  expect(capped.results).toHaveLength(102);
  expect(capped.results.filter(item => item.status === "passed")).toHaveLength(100);
  expect(capped.results.slice(100)).toMatchObject(endpoints.slice(100).map(endpoint => ({
    source: endpoint.id, endpoint, status: "not-run", reason: "超出本轮 100 个地址探测上限",
  })));
  expect(capped.results.every(item => item.error === undefined)).toBe(true);
});

test("endpoint-only services are discovered offline and execute in deps", async () => {
  const definition = { ...service, endpoints: [] };
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([definition]) };
  const providers = healthProviders(plugin);
  let calls = 0;
  const entered: string[] = [];
  const actions = { endpoints: async () => { calls++; return [{ source: "download", workload: "main", status: "none" as const }]; }, cases: async () => [], show: () => {} };
  const result = await runHealthSession(providers, {}, { ...actions, scopes: ["deps"], enterScope: async scope => { entered.push(scope); return true; } });
  expect(calls).toBe(1); expect(entered).toEqual(["deps"]);
  expect(result.providers[0]!.endpoints?.[0]!.status).toBe("none");
  await runHealthSession(providers, {}, { ...actions, signal: AbortSignal.abort() });
  expect(calls).toBe(1);
});

test("generic Endpoint actions stay outside an executing self scope", async () => {
  const value = { summary: () => ({ title: "Self", fields: [] }) };
  const observation = defineObservation({ kind: "self", schemaVersion: 1, codec: { encode: () => ({}), decode: () => value } });
  const self = defineWorkloadProbeExtension({ id: "self", kind: "workload.probe", health: "self", workload: "main",
    access: {}, produces: observation, run: async () => ({ status: "ok", value }) });
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([{ ...service, endpoints: [endpoint], extensions: [self] }]) };
  const calls: string[] = [];
  const result = await runHealthSession(healthProviders(plugin), {}, { scopes: ["self"],
    enterScope: async scope => { calls.push(`enter:${scope}`); return true; },
    probes: async (provider, scope) => {
      expect(provider.probes).toEqual([self]);
      calls.push(scope);
      return [{ probe: "self", scope, status: "ok", observations: [], findings: [] }];
    }, endpoints: async () => { calls.push("endpoints"); return []; }, cases: async () => [], show: () => {} });
  expect(calls).toEqual(["enter:self", "self"]);
  expect(result.providers[0]!.endpoints).toBeUndefined();
});

test("catalog rejects duplicate identities, invalid addresses and name-only consumers", () => {
  for (const endpoints of [[endpoint, endpoint], [{ ...endpoint, workload: "main" as unknown as NonNullable<Endpoint["workload"]> }], [{ ...endpoint, port: 0 }]]) {
    expect(() => createServiceCatalog([{ ...service, endpoints }])).toThrow();
  }
});

test("health command selects Endpoint-only deps and propagates failed and empty outcomes", async () => {
  const definition = { ...service, endpoints: [] };
  const context = new CommandContext({}, undefined, { yes: true, plugin: { id: "fixture", version: "1", services: createServiceCatalog([definition]) } });
  context.ensureEnvironment = async () => {};
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture", kubernetes: { namespace: "demo", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({ run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }), exec: async () => { throw new Error("unexpected exec"); } });
  let status: "failed" | "none" | "not-run" = "failed";
  const checks = spyOn(endpointChecks, "checkHealthEndpoints").mockImplementation(async provider => {
    expect(provider.endpoints).toEqual(definition.endpoints);
    return [{ source: "download", workload: "main", status }];
  });
  const artifacts: Array<{ path: string }> = [];
  try {
    for (const [outcome, expected] of [["failed", CommandStatus.Failed], ["none", CommandStatus.Ok], ["not-run", CommandStatus.Partial]] as const) {
      status = outcome;
      const result = await healthCommand.run(context, { services: ["worker"], scope: "deps" });
      artifacts.push(...result.artifacts);
      expect(result.status).toBe(expected);
      expect(result.output!.providers[0]!.endpoints?.[0]?.status).toBe(outcome);
    }
  } finally {
    checks.mockRestore(); config.mockRestore(); executor.mockRestore(); await context.disposeClients();
    for (const artifact of artifacts) rmSync(artifact.path, { recursive: true, force: true });
  }
});


test("Endpoint carries its consumer declaration without Service name lookup or same-name conflation", async () => {
  const first = kubernetesServiceWorkload("consumer-one", { name: "inline", namespace: "demo", container: "worker" });
  const second = kubernetesServiceWorkload("consumer-two", { name: "inline", namespace: "demo", container: "worker" });
  const result = await check([{ ...endpoint, workload: first }, { ...endpoint, id: "second", workload: second }]);
  expect(result.results.map(item => item.status)).toEqual(["passed", "passed"]);
  expect(result.declarations).toEqual([first, second]);
  expect(result.discoveries).toBe(2);
  expect(result.results.map(item => item.endpoint?.workload)).toEqual([first, second]);
});


test("unexecutable Pods retain coverage and do not consume Running instance slots", async () => {
  const pending = Array.from({ length: 10 }, (_, i) => `pending-${i}`);
  const result = await check([endpoint], { pods: [...pending, "worker-0"], pending });
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]!.pod).toBe("worker-0");
  expect(result.results).toHaveLength(1);
  expect(result.results.at(-1)!.status).toBe("passed");
  const unavailable = await check([endpoint], { pods: pending, pending });
  expect(unavailable.commands).toEqual([]);
  expect(unavailable.results.at(-1)!.status).toBe("unavailable");
});
