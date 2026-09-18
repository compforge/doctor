import { expect, spyOn, test } from "bun:test";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { KubernetesPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { redisDataSource, s3DataSource } from "@compforge/doctor-plugin";
import { RedisClient } from "@compforge/harness-toolbox/redis/index";
import { CommandContext } from "../src/command";
import { resolveDataSourceTarget } from "../src/datasource/workload";
import { borrowServiceClient } from "../src/datasource/client";
import { resolveKubernetesEnvironment } from "../src/infra/k8s/environment";
import { instanceLogAccess } from "../src/infra/k8s/instance-log";
import { logPlugin, logService } from "./log-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceBundle } from "../src/collect/evidence";
import { resolveStoreProviderConfig } from "../src/collect/store/config";
import { makeS3ConfigurationInspect, makeS3AccessInspect, makeS3ProviderInspect } from "../src/collect/store/s3/fact/inspect";
import type { S3CommandContext } from "../src/collect/store/s3/context";
import { resolveRedisConfig } from "../src/collect/redis/config";
import { confirmRedisTarget, prepareRedisAccess } from "../src/collect/redis/preparation";
import type { ServiceRedisClient, ServiceVdbClient } from "@compforge/doctor-plugin";
import { resolveCollectKubeconfig } from "../src/infra/k8s/context";
import { vdbConfigFromStore } from "../src/collect/store/vdb/config";
import type { VdbCommandContext } from "../src/collect/store/vdb/context";
import { makeVdbConfigurationInspect, makeVdbAccessInspect } from "../src/collect/store/vdb/fact/inspect";
import { ServiceDependencyRuntime } from "../src/collect/shared/service-dependency";

const ok = { ok: true, exitCode: 0, stderr: "", durationMs: 1, timedOut: false, command: [] };
function executor(environment = "dev\nhttps://cluster-a.test", uid = "uid-a") {
  const calls: string[][] = [];
  const pod = { metadata: { name: "physical-0", uid, namespace: "demo" }, spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
    status: { phase: "Running", containerStatuses: [{ name: "app", containerID: "runtime-a" }] } };
  const exec: Executor = {
    run: async args => {
      calls.push(args);
      if (args[0] === "config") return { ...ok, command: args, stdout: environment };
      if (args[1] === "pods") return { ...ok, command: args,
        stdout: JSON.stringify(args[2] === "physical-0" ? pod : { items: [pod] }) };
      if (args.join(" ") === "get services physical-v2 -o json") return { ...ok, command: args,
        stdout: JSON.stringify({ metadata: { name: "physical-v2" }, spec: { selector: { app: "physical" } } }) };
      throw new Error("Unexpected access: " + args.join(" "));
    },
    exec: async () => { throw new Error("No exec during selection"); },
  };
  return { exec, calls, pod };
}

test("DataSource resolves declared physical resource and container, not logical name or sidecar", async () => {
  const f = executor();
  const command = new CommandContext({});
  const service = { ...logService("logical"), workloads: [{ name: "api", platform: "kubernetes" as const,
    location: { kind: "service" as const, name: "physical-v2" }, container: "app" }] };
  const input = { service, executor: f.exec, namespace: "demo", interactive: false, commandContext: command,
    selection: { purpose: "configuration" } };
  try {
    expect(await resolveDataSourceTarget(input)).toEqual({ pod: "physical-0", container: "app" });
    expect(f.calls.some(args => args.includes("logical"))).toBeFalse();
    await expect(resolveDataSourceTarget({ ...input, container: "sidecar" })).rejects.toThrow("未声明 Container");
    await expect(resolveDataSourceTarget({ ...input, service: { ...service, workloads: [] } })).rejects.toThrow("没有匹配");
    await expect(resolveDataSourceTarget({ ...input, service: { ...service, workloads: [
      { ...service.workloads[0]!, namespace: "other" },
    ] } })).rejects.toThrow("--namespace other");
  } finally { await command.disposeClients(); }
});

test("Environment is effective cluster/context; profile labels and config paths cannot supply identity", async () => {
  const a = executor(), same = executor(), b = executor("dev\nhttps://cluster-b.test"), context = executor("admin\nhttps://cluster-a.test");
  const first = await resolveKubernetesEnvironment(a.exec);
  expect((await resolveKubernetesEnvironment(same.exec)).name).toBe(first.name);
  expect((await resolveKubernetesEnvironment(b.exec)).name).not.toBe(first.name);
  expect((await resolveKubernetesEnvironment(context.exec)).name).not.toBe(first.name);
  await resolveKubernetesEnvironment(a.exec);
  expect(a.calls).toHaveLength(1);
  await expect(resolveKubernetesEnvironment(executor("").exec)).rejects.toThrow("缺少");
});

test("Explicit kubeconfig chooses Environment even when profile kubeconfig is invalid", () => {
  const profile = { name: "saved", configPath: "", value: { readonly: true,
    kube: { kubeconfig_path: "/does-not-exist/profile-kubeconfig" } }, pluginConfig: {} };
  expect(resolveCollectKubeconfig({ kubeconfig: "/selected-kubeconfig" }, profile))
    .toEqual({ kubeconfig: "/selected-kubeconfig", source: "flag" });
  expect(() => resolveCollectKubeconfig({}, profile)).toThrow("path not found");
});

test("Log reads reject a replacement before capture and mark an in-stream replacement unavailable", async () => {
  const f = executor();
  let reads = 0;
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => ({ ...ok, stdout: "test" }),
    listServicePods: async () => { throw new Error("No name-based discovery"); },
    collectPodLogs: async () => { reads++; f.pod.metadata.uid = "replacement";
      return { ...ok, stdout: "foreign logs", captureStatus: "complete", bytesRead: 12, attempts: 1 }; },
  };
  const expected = { pod: "physical-0", container: "app", uid: "uid-a", instance: JSON.stringify(["uid-a", "runtime-a"]) };
  const guarded = instanceLogAccess(access, f.exec, expected);
  expect((await guarded.collectPodLogs(expected)).captureStatus).toBe("unavailable");
  expect(reads).toBe(1);
  expect((await guarded.collectPodLogs(expected)).captureStatus).toBe("unavailable");
  expect(reads).toBe(1);
});

test("Log verification detects container restarts and marks missing runtime identity partial", async () => {
  const f = executor();
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => ({ ...ok, stdout: "test" }),
    listServicePods: async () => { throw new Error("unused"); },
    collectPodLogs: async () => ({ ...ok, stdout: "logs", captureStatus: "complete", bytesRead: 4, attempts: 1 }),
  };
  const expected = { pod: "physical-0", container: "app", uid: "uid-a" };
  expect((await instanceLogAccess(access, f.exec, expected).collectPodLogs(expected)).captureStatus).toBe("partial");
  expect((await instanceLogAccess(access, f.exec, { ...expected, instance: JSON.stringify(["uid-a", "old-runtime"]) })
    .collectPodLogs(expected)).captureStatus).toBe("unavailable");
});

test("S3 source resolves once through root ClientManager without a configuration Pod", async () => {
  const f = executor();
  let resolves = 0;
  const source = s3DataSource("archive", async context => {
    resolves++;
    expect(context.target.service.environment.name).toBe((await resolveKubernetesEnvironment(f.exec)).name);
    return { endpoint: "http://127.0.0.1:9000", region: "test", forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" }, bucket: "archive" };
  });
  const service = { ...logService(), workloads: [], capabilities: { dataSources: [
    { id: "archive", kind: "s3" as const, backend: "s3-compatible" as const, source },
  ] } };
  const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
  const root = mkdtempSync(join(tmpdir(), "doctor-s3-source-"));
  const collect = { profileName: "default", kubernetes: { namespace: "demo", namespaceSource: "default" as const, kubeconfigSource: "flag" } };
  try {
    const one = await borrowServiceClient(command, collect, f.exec, service.name, {}, source);
    const two = await borrowServiceClient(command, collect, f.exec, service.name, {}, source);
    expect(one).toBe(two);
    expect(one.target.bucket).toBe("archive");
    expect(resolves).toBe(1);
    const selected = await resolveStoreProviderConfig({ type: "s3", service: service.name, interactive: false },
      command.plugin, collect, f.exec, command);
    expect(selected!.config.target).toBeUndefined();
    const ctx: S3CommandContext = { command, executor: f.exec, config: selected!.config,
      capability: service.capabilities.dataSources[0]!, bundle: new EvidenceBundle(root,
        ["runtime-config", "access-preparation", "provider-detection"].map(id => ({ id, title: id, risk: "observe" }))), log: () => {} };
    const facts = await makeS3ConfigurationInspect().run(ctx, {});
    expect(facts.configuration).toMatchObject({ status: "collected", bucket: "archive", source: "plugin" });
    expect((await makeS3AccessInspect().run(ctx, facts)).access).toMatchObject({ status: "collected", channel: "plugin" });
    expect((await makeS3ProviderInspect().run(ctx, facts)).provider?.status).toBe("unavailable");
    expect(JSON.stringify(facts)).not.toContain("secretAccessKey");
    expect(resolves).toBe(1);
    expect(f.calls.every(args => args[0] === "config")).toBeTrue();
  } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});

test("Redis source needs neither same-name K8s Service nor Pod exec and never closes a borrowed client", async () => {
  const f = executor();
  let starts = 0, closes = 0;
  const client: ServiceRedisClient = {
    mask: () => ({ kind: "redis" }),
    target: { endpoints: [["redis.example.org", 6379]], database: 0, useSsl: false, timeout: 1000,
      clusterType: "single", sentinelHosts: [], sentinelMasterName: "" },
    access: { connection: async () => { throw new Error("No protocol calls in preparation"); }, close: async () => { throw new Error("Borrower cannot close"); } },
    initialize: async () => { starts++; }, dispose: async () => { closes++; },
  };
  const service = { ...logService(), workloads: [], capabilities: { dataSources: [{
    id: "cache", kind: "redis" as const, backend: "redis" as const, source: { clientKey: "cache", createClient: () => client },
  }] } };
  const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
  try {
    const result = await resolveRedisConfig({ namespace: "demo", service: service.name, maxKeys: "1", maxKeysPerSecond: "1", top: "1" },
      command, f.exec, command.plugin.services);
    expect(result!.config.target).toBeUndefined();
    const confirmed = await confirmRedisTarget(f.exec, undefined, result!.config);
    expect(confirmed.targetFact).toMatchObject({ status: "collected", endpointSource: "plugin" });
    const prepared = await prepareRedisAccess(f.exec, result!.config, confirmed.target!);
    expect(prepared.access).toBe(client.access);
    await prepared.close();
    expect(starts).toBe(1); expect(closes).toBe(0);
    expect(f.calls.every(args => args[0] === "config")).toBeTrue();
  } finally { await command.disposeClients(); }
  expect(closes).toBe(1);
});

test("Redis source helper preserves the collection timeout unit at the toolbox boundary", async () => {
  const f = executor();
  let timeoutMs: number | undefined;
  const initialize = RedisClient.prototype.initialize;
  const observed = spyOn(RedisClient.prototype, "initialize").mockImplementation(async function(this: RedisClient) {
    await initialize.call(this);
    timeoutMs = this.target.timeoutMs;
  });
  const source = redisDataSource("cache", async () => ({ endpoints: [["redis.example.org", 6379]],
    database: 0, useSsl: false, timeout: 2, clusterType: "single", sentinelHosts: [], sentinelMasterName: "" }));
  const service = { ...logService(), workloads: [], capabilities: { dataSources: [{
    id: "cache", kind: "redis" as const, backend: "redis" as const, source,
  }] } };
  const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
  try {
    await borrowServiceClient(command, { profileName: "default", kubernetes: { namespace: "demo", namespaceSource: "default", kubeconfigSource: "default" } },
      f.exec, service.name, { access: {} }, source);
    expect(timeoutMs).toBe(2_000);
  } finally {
    try { await command.disposeClients(); } finally { observed.mockRestore(); }
  }
});

test("VDB source supplies typed access to the existing Collect flow without disclosing endpoint credentials", async () => {
  const f = executor();
  const client: ServiceVdbClient = {
    mask: () => ({ kind: "vdb" }),
    target: { backend: "opensearch", store: "search", endpoint: "https://reader:private-password@search.example.org",
      configurationKind: "api" },
    access: { count: async () => 0, search: async () => ({ hits: { hits: [] } }),
      request: async () => ({}), close: async () => {} },
    initialize: async () => {}, dispose: async () => {},
  };
  const service = { ...logService(), workloads: [], capabilities: { dataSources: [{
    id: "search", kind: "vdb" as const, backend: "opensearch" as const, source: { clientKey: "search", createClient: () => client },
  }] } };
  const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
  const root = mkdtempSync(join(tmpdir(), "doctor-vdb-source-"));
  const collect = { profileName: "default", kubernetes: { namespace: "demo", namespaceSource: "default" as const, kubeconfigSource: "flag" } };
  try {
    const selected = await resolveStoreProviderConfig({ type: "vdb", service: service.name, interactive: false },
      command.plugin, collect, f.exec, command);
    expect(selected!.config.target).toBeUndefined();
    const config = vdbConfigFromStore(selected!.config);
    const ctx: VdbCommandContext = { command, executor: f.exec, config, kube: collect.kubernetes,
      bundle: new EvidenceBundle(root, ["runtime-config", "access-preparation"].map(id => ({ id, title: id, risk: "observe" }))), log: () => {} };
    const facts = await makeVdbConfigurationInspect(config).run(ctx, {});
    expect(facts.configuration).toMatchObject({ status: "collected", endpoint: "https://search.example.org" });
    expect(JSON.stringify(facts)).not.toContain("private-password");
    expect((await makeVdbAccessInspect(config).run(ctx, facts)).access).toMatchObject({ status: "collected", channel: "plugin" });
    expect(ctx.search).toBe(client.access);
    const dependencies = new ServiceDependencyRuntime({ plugin: command.plugin, collect, executor: f.exec,
      command: "doctor trace", commandContext: command, index: "traces", log: () => {} });
    const prepared = await dependencies.prepareDataSource(service.name, "search");
    expect(prepared.search).toBe(client.access);
    expect(JSON.stringify(prepared.evidenceTarget)).not.toContain("private-password");
    await dependencies.close();
    expect(f.calls.every(args => args[0] === "config")).toBeTrue();
  } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});
