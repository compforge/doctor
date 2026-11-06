import { expect, test, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { createServiceCatalog, defineWorkloadProbeExtension, defineObservation, kubernetesServiceWorkload, withSummary,
  type FacetSummarizeExtension, type PluginContext, type ServiceDefinition } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { healthCommand } from "../src/health";
import { healthProviders } from "../src/health/extensions";
import { healthScopes } from "../src/health/scopes";
import { checkDependencyHealthProbes, validateDownstreams } from "../src/health/deps/probes";
import { checkSelfHealthProbes } from "../src/health/self/probes";
import * as probes from "../src/health/probe-runner";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import * as discovery from "../src/infra/k8s/workload";
import * as access from "../src/terminal/kubernetes-access";
import * as caseRuntime from "../src/health/runtime";
import * as overviewSelection from "../src/overview/selection";
import { buildHealthHtml } from "../src/health/report";
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

for (const [acquisitionStatus, includeUnsupported] of [["ok", false], ["unavailable", false], ["ok", true]] as const) {
test(`self-only command skips business preparation and preserves ${acquisitionStatus}, unsupported=${includeUnsupported}, independently of findings`, async () => {
  let businessCalled = false;
  const service: ServiceDefinition = { ...api, extensions: [probe, { id: "cases", kind: "health.case.bindings", access: {},
    run: withSummary({ title: "Must not run", fields: [] }, async () => { businessCalled = true; throw new Error("business should not run"); }) }] };
  const dependencyProbe = defineWorkloadProbeExtension({ ...probe, health: "deps", run: async () => ({ status: "ok", value: value() }) });
  const worker: ServiceDefinition = { ...api, name: "worker", extensions: [dependencyProbe] };
  const context = new CommandContext({}, undefined, { plugin: { id: "fixture", version: "1", services: createServiceCatalog([service, worker]) } });
  context.ensureEnvironment = async () => {};
  const config = spyOn(targets, "resolveKubernetesCommandConfig").mockResolvedValue({ profileName: "fixture", kubernetes: { namespace: "test", namespaceSource: "flag", kubeconfigSource: "flag" } });
  const executor = spyOn(targets, "createKubernetesExecutor").mockReturnValue({ run: async args => ({ ok: true, stdout: "fixture\nhttps://cluster.example", stderr: "", exitCode: 0, command: args, durationMs: 1, timedOut: false }), exec: async () => { throw new Error("unexpected exec"); } });
  const windowSelection = spyOn(overviewSelection, "selectOverviewWindow").mockResolvedValue(undefined);
  const checks = spyOn(probes, "runHealthProbes").mockImplementation(async provider => {
    expect(provider.probes).toEqual([probe]);
    return [{ probe: "startup", scope: "self", status: acquisitionStatus, reason: "fixture", observations: [], findings: [{
      id: "warning", kind: "fixture", schemaVersion: 1, severity: "warning", confidence: "high", message: "degraded", evidence: [],
    }] }];
  });
  const artifacts: { path: string }[] = [];
  try {
    const result = await healthCommand.run(context, { services: includeUnsupported ? ["api", "worker"] : ["api"], scope: "self" });
    artifacts.push(...result.artifacts);
    expect(businessCalled).toBe(false);
    expect(windowSelection).not.toHaveBeenCalled();
    expect(result.output?.query).not.toHaveProperty("window");
    expect(result.output?.checkedAt).toBeDefined();
    expect(buildHealthHtml(result.output!)).not.toContain("统计窗口");
    expect(result.status).toBe(includeUnsupported ? CommandStatus.Partial : acquisitionStatus === "ok" ? CommandStatus.Ok : CommandStatus.Failed);
    if (includeUnsupported) {
      expect(result.output?.providers[1]?.unsupported).toContain("worker");
      expect(buildHealthHtml(result.output!)).toContain("未声明 self");
    }
    expect(result.output?.providers[0]!.probes?.[0]?.findings[0]?.message).toBe("degraded");
  } finally {
    checks.mockRestore(); windowSelection.mockRestore(); config.mockRestore(); executor.mockRestore(); await context.disposeClients();
    for (const artifact of artifacts) rmSync(artifact.path, { recursive: true, force: true });
  }
});
}

const statistics: FacetSummarizeExtension = {
  id: "summary", kind: "facet.summarize", namespace: "plugin/fixture/service/api", access: {},
  facets: [{ id: "status", title: "Status", description: "Fixture" }],
  run: withSummary({ title: "Stats", fields: [] }, async () => []),
};
const statisticsService: ServiceDefinition = { name: "store", workloads: [kubernetesServiceWorkload("store")],
  component: { name: "store", repository: { forge: { name: "fixture" }, path: "fixture/store" } }, extensions: [statistics] };

for (const statuses of [["unavailable"], ["unavailable", "unavailable"], ["ok", "unavailable"], ["partial"], ["ok"]] as const) {
  test(`Probe uses its owner with cross-Service statistics and aggregates ${statuses.join("/")}`, async () => {
    const selectedProbe = defineWorkloadProbeExtension({ ...probe, run: async (_context, input) => {
      const status = statuses[Number(input.instance.uid)]!;
      return status === "ok" ? { status, value: value() }
        : { status, reason: "fixture acquisition gap", value: value() };
    } });
    const service: ServiceDefinition = { ...api, extensions: [selectedProbe] };
    const plugin = { id: "fixture", version: "1", services: createServiceCatalog([service, statisticsService]) };
    const provider = healthProviders(plugin, ["api"])[0]!;
    expect(provider.service.name).toBe("api");
    const context = new CommandContext({}, undefined, { plugin });
    const unavailable = async (): Promise<never> => { throw new Error("unexpected external execution"); };
    const executor: Executor = { run: unavailable, exec: unavailable };
    const environment = spyOn(context, "environment").mockResolvedValue({ environment: { name: "fixture" } } as Awaited<ReturnType<CommandContext["environment"]>>);
    const permission = spyOn(access, "enforceKubernetesAccess").mockResolvedValue({ command: "fixture", facts: [], runnable: true });
    const workloads = spyOn(discovery, "discoverKubernetesWorkload").mockImplementation(async definition => {
      expect(definition.location).toEqual({ kind: "service", name: "api" });
      return { definition, pods: [], instances: statuses.map((_status, index) => ({ platform: "kubernetes", environment: "fixture",
        namespace: "test", workload: definition.name, pod: `api-${index}`, uid: String(index), container: "server" })) };
    });
    const invocation = spyOn(caseRuntime, "caseOperationInvoker").mockReturnValue(async (owner, operation, input) => {
      expect(owner.name).toBe("api");
      return (await operation.run({} as PluginContext, input)).data;
    });
    try {
      const checks = await checkSelfHealthProbes(provider, context, executor, { namespace: "test" });
      const expected = statuses.every(status => status === "unavailable") ? "unavailable"
        : statuses.every(status => status === "ok") ? "ok" : "partial";
      expect(checks[0]!.status).toBe(expected);
      expect(checks[0]!.observations).toHaveLength(statuses.length);
      expect(checks[0]!.observations.every(item => item.services[0] === "api" && item.producer.origin === "plugin" && item.producer.service === "api")).toBe(true);
    } finally {
      invocation.mockRestore(); workloads.mockRestore(); permission.mockRestore(); environment.mockRestore(); await context.disposeClients();
    }
  });
}

for (const scope of ["self", "deps"] as const) {
  test(`${scope} Probe prepares only its own layer's input for each consumer instance`, async () => {
    const calls: string[] = [];
    const relation = { id: "store", service: "api", workload: "main", endpoint: { host: "store.fixture", port: 443, tls: true } };
    const extension: import("@compforge/doctor-plugin").ServiceDownstreamsExtension = {
      id: "downstreams", kind: "service.downstreams", access: {},
      run: withSummary({ title: "Dependencies", fields: [] }, async (_context, input) => {
        calls.push(`${input.instance?.pod}:${input.bizId}`);
        return [relation];
      }),
    };
    const definition = { ...api, extensions: [
      { ...probe, health: scope }, extension,
      { ...extension, id: "other-namespace", namespace: "plugin/fixture", run: withSummary({ title: "Wrong scope", fields: [] }, async () => {
        throw new Error("must not read another namespace");
      }) },
    ] };
    const context = new CommandContext({}, undefined, { plugin: { id: "fixture", version: "1", services: createServiceCatalog([definition]) } });
    const provider = healthProviders(context.plugin, ["api"])[0]!;
    const unavailable = async (): Promise<never> => { throw new Error("unexpected external execution"); };
    const executor: Executor = { run: unavailable, exec: unavailable };
    const invoke = spyOn(caseRuntime, "caseOperationInvoker").mockReturnValue(async (owner, operation, input) => {
      expect(owner.name).toBe("api");
      return (await operation.run({} as PluginContext, input)).data;
    });
    const run = spyOn(probes, "runHealthProbes").mockImplementation(async (_provider, _context, _executor, _kube, prepare) => {
      for (const pod of ["api-0", "api-1"]) {
        const input = await prepare({ platform: "kubernetes", environment: "fixture", namespace: "test", workload: "main", pod, uid: pod, container: "server" });
        expect(input).toEqual({ bizId: "business-1", downstreams: scope === "deps" ? [relation] : [] });
      }
      return [];
    });
    try {
      const check = scope === "self" ? checkSelfHealthProbes : checkDependencyHealthProbes;
      await check(provider, context, executor, { namespace: "test" }, "business-1");
      expect(calls).toEqual(scope === "deps" ? ["api-0:business-1", "api-1:business-1"] : []);
    } finally { run.mockRestore(); invoke.mockRestore(); await context.disposeClients(); }
  });
}

test("Probe cancellation preserves earlier observations and records unstarted Probes", async () => {
  const calls: string[] = [];
  const active = defineWorkloadProbeExtension({ ...probe, id: "active", run: async (plugin, input) => {
    calls.push(`active:${input.instance.pod}`);
    if (input.instance.pod === "api-1") {
      const cancelled = new Promise<never>((_resolve, reject) => plugin.signal.addEventListener("abort", () => reject(plugin.signal.reason), { once: true }));
      context.cancel();
      return await cancelled;
    }
    return { status: "ok", value: value() };
  } });
  const last = defineWorkloadProbeExtension({ ...probe, id: "last", run: async () => { throw new Error("must not run"); } });
  const plugin = { id: "fixture", version: "1", services: createServiceCatalog([{ ...api, extensions: [probe, active, last] }]) };
  const context = new CommandContext({}, undefined, { plugin });
  const environment = spyOn(context, "environment").mockResolvedValue({ environment: { name: "fixture" } } as Awaited<ReturnType<CommandContext["environment"]>>);
  const permission = spyOn(access, "enforceKubernetesAccess").mockResolvedValue({ command: "fixture", facts: [], runnable: true });
  const workloads = spyOn(discovery, "discoverKubernetesWorkload").mockImplementation(async definition => ({ definition, pods: [],
    instances: [0, 1].map(index => ({ platform: "kubernetes" as const, environment: "fixture", namespace: "test", workload: "main", pod: `api-${index}`, uid: String(index), container: "server" })) }));
  const invoke = spyOn(caseRuntime, "caseOperationInvoker").mockReturnValue(async (_service, operation, input) =>
    (await operation.run({ signal: context.signal } as PluginContext, input)).data);
  try {
    const result = await checkSelfHealthProbes(healthProviders(plugin)[0]!, context, {} as Executor, { namespace: "test" });
    expect(result.map(check => check.status)).toEqual(["ok", "cancelled", "not-run"]);
    expect(result.map(check => check.observations.length)).toEqual([2, 1, 0]);
    expect(calls).toEqual(["active:api-0", "active:api-1"]);
    expect(workloads).toHaveBeenCalledTimes(2);
    const html = buildHealthHtml({ query: {}, providers: [{ name: "api", namespace: "fixture", probes: result }] });
    expect(html).toContain("已取消"); expect(html).toContain("未执行");
  } finally {
    invoke.mockRestore(); workloads.mockRestore(); permission.mockRestore(); environment.mockRestore(); await context.disposeClients();
  }
});
