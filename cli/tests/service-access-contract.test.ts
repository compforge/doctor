import { KubernetesClient } from "@compforge/harness-toolbox/kubernetes/client";
import { startS3Fixture } from "./s3-fixture";
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const pod = {
    metadata: { name: "physical-0", uid, namespace: "demo" }, spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
    status: { phase: "Running", containerStatuses: [{ name: "app", containerID: "runtime-a" }] }
  };
  const exec: Executor = {
    run: async args => {
      calls.push(args);
      if (args[0] === "config") return { ...ok, command: args, stdout: environment };
      if (args[1] === "pods") return {
        ...ok, command: args,
        stdout: JSON.stringify(args[2] === "physical-0" ? pod : { items: [pod] })
      };
      if (args.join(" ") === "get services physical-v2 -o json") return {
        ...ok, command: args,
        stdout: JSON.stringify({ metadata: { name: "physical-v2" }, spec: { selector: { app: "physical" } } })
      };
      throw new Error("Unexpected access: " + args.join(" "));
    },
    exec: async () => { throw new Error("No exec during selection"); },
  };
  return { exec, calls, pod };
}

test("DataSource resolves declared physical resource and container, not logical name or sidecar", async () => {
  const f = executor();
  const command = new CommandContext({});
  const service = {
    ...logService("logical"), workloads: [{
      name: "api", platform: "kubernetes" as const,
      location: { kind: "service" as const, name: "physical-v2" }, container: "app"
    }]
  };
  const input = {
    service, executor: f.exec, namespace: "demo", interactive: false, commandContext: command,
    selection: { purpose: "configuration" }
  };
  try {
    expect(await resolveDataSourceTarget(input)).toEqual({ pod: "physical-0", container: "app" });
    expect(f.calls.some(args => args.includes("logical"))).toBeFalse();
    await expect(resolveDataSourceTarget({ ...input, container: "sidecar" })).rejects.toThrow("未声明 Container");
    await expect(resolveDataSourceTarget({ ...input, service: { ...service, workloads: [] } })).rejects.toThrow("没有匹配");
    await expect(resolveDataSourceTarget({
      ...input, service: {
        ...service, workloads: [
          { ...service.workloads[0]!, namespace: "other" },
        ]
      }
    })).rejects.toThrow("--namespace other");
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
  const dir = mkdtempSync(join(tmpdir(), "doctor-kube-"));
  const selected = join(dir, "selected-kubeconfig");
  writeFileSync(selected, "apiVersion: v1\n");
  try {
    const profile = {
      name: "saved", configPath: "", value: {
        readonly: true,
        kube: { kubeconfig_path: "/does-not-exist/profile-kubeconfig" }
      }, pluginConfig: {}
    };
    expect(resolveCollectKubeconfig({ kubeconfig: selected }, profile))
      .toEqual({ kubeconfig: selected, source: "flag" });
    expect(() => resolveCollectKubeconfig({}, profile)).toThrow("path not found");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Log reads reject a replacement before capture and mark an in-stream replacement unavailable", async () => {
  const f = executor();
  let reads = 0;
  const access: KubernetesPodLogAccess = {
    clientVersion: async () => ({ ...ok, stdout: "test" }),
    listServicePods: async () => { throw new Error("No name-based discovery"); },
    collectPodLogs: async () => {
      reads++; f.pod.metadata.uid = "replacement";
      return { ...ok, stdout: "foreign logs", captureStatus: "complete", bytesRead: 12, attempts: 1 };
    },
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
    return {
      endpoint: "http://127.0.0.1:9000", region: "test", forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" }, bucket: "archive"
    };
  });
  const service = {
    ...logService(),
    workloads: [],
    dataSources: [
      { id: "archive", kind: "s3" as const, backend: "s3-compatible" as const, source },
    ]
  };
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
    const ctx: S3CommandContext = {
      command, executor: f.exec, config: selected!.config,
      capability: service.dataSources[0]!, bundle: new EvidenceBundle(root,
        ["runtime-config", "access-preparation", "provider-detection"].map(id => ({ id, title: id, risk: "observe" }))), log: () => { }
    };
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
    target: {
      endpoints: [{ host: "redis.example.org", port: 6379 }], database: 0, useSsl: false, timeoutMs: 1000,
      clusterType: "single"
    },
    access: { connection: async () => { throw new Error("No protocol calls in preparation"); }, close: async () => { throw new Error("Borrower cannot close"); } },
    topology: async () => { throw new Error("No topology in preparation"); },
    initialize: async () => { starts++; }, dispose: async () => { closes++; },
  };
  const service = {
    ...logService(),
    workloads: [],
    dataSources: [{
      id: "cache", kind: "redis" as const, backend: "redis" as const, source: { clientKey: "cache", createClient: () => client },
    }]
  };
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

test("Redis source helper preserves toolbox target and timeout budgets", async () => {
  const f = executor();
  let timeoutMs: number | undefined;
  const initialize = RedisClient.prototype.initialize;
  const observed = spyOn(RedisClient.prototype, "initialize").mockImplementation(async function(this: RedisClient) {
    await initialize.call(this);
    timeoutMs = this.target.timeoutMs;
  });
  const target = {
    endpoints: [{ host: "sentinel.example.org", port: 26379 }],
    database: 2, useSsl: true, timeoutMs: 2000, connectTimeoutMs: 1000, acquireTimeoutMs: 3000,
    clusterType: "sentinel" as const, sentinelMasterName: "primary",
    username: "data-user", password: "data-password", sentinelUsername: "sentinel-user", sentinelPassword: "sentinel-password",
  };
  const source = redisDataSource("cache", async () => target);
  const service = {
    ...logService(),
    workloads: [],
    dataSources: [{
      id: "cache", kind: "redis" as const, backend: "redis" as const, source,
    }]
  };
  const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
  try {
    const client = await borrowServiceClient(command, { profileName: "default", kubernetes: { namespace: "demo", namespaceSource: "default", kubeconfigSource: "default" } },
      f.exec, service.name, { access: {} }, source);
    expect(client.target).toEqual(target);
    expect(timeoutMs).toBe(2_000);
  } finally {
    try { await command.disposeClients(); } finally { observed.mockRestore(); }
  }
});

test("VDB source supplies typed access to the existing Collect flow without disclosing endpoint credentials", async () => {
  const f = executor();
  const client: ServiceVdbClient = {
    target: {
      backend: "opensearch", store: "search", endpoint: "https://reader:private-password@search.example.org",
      configurationKind: "api"
    },
    access: {
      count: async () => 0, search: async () => ({ hits: { hits: [] } }),
      request: async () => ({}), close: async () => { }
    },
    initialize: async () => { }, dispose: async () => { },
  };
  const service = {
    ...logService(),
    workloads: [],
    dataSources: [{
      id: "search", kind: "vdb" as const, backend: "opensearch" as const, source: { clientKey: "search", createClient: () => client },
    }]
  };
  const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
  const root = mkdtempSync(join(tmpdir(), "doctor-vdb-source-"));
  const collect = { profileName: "default", kubernetes: { namespace: "demo", namespaceSource: "default" as const, kubeconfigSource: "flag" } };
  try {
    const selected = await resolveStoreProviderConfig({ type: "vdb", service: service.name, interactive: false },
      command.plugin, collect, f.exec, command);
    expect(selected!.config.target).toBeUndefined();
    const config = vdbConfigFromStore(selected!.config);
    const ctx: VdbCommandContext = {
      command, executor: f.exec, config, kube: collect.kubernetes,
      bundle: new EvidenceBundle(root, ["runtime-config", "access-preparation"].map(id => ({ id, title: id, risk: "observe" }))), log: () => { }
    };
    const facts = await makeVdbConfigurationInspect(config).run(ctx, {});
    expect(facts.configuration).toMatchObject({ status: "collected", endpoint: "https://search.example.org" });
    expect(JSON.stringify(facts)).not.toContain("private-password");
    expect((await makeVdbAccessInspect(config).run(ctx, facts)).access).toMatchObject({ status: "collected", channel: "plugin" });
    expect(ctx.search).toBe(client.access);
    const dependencies = new ServiceDependencyRuntime({
      plugin: command.plugin, collect, executor: f.exec,
      command: "doctor trace", commandContext: command, index: "traces", log: () => { }
    });
    const prepared = await dependencies.prepareDataSource(service.name, "search");
    expect(prepared.search).toBe(client.access);
    expect(JSON.stringify(prepared.evidenceTarget)).not.toContain("private-password");
    await dependencies.close();
    expect(f.calls.every(args => args[0] === "config")).toBeTrue();
  } finally { await command.disposeClients(); rmSync(root, { recursive: true, force: true }); }
});

for (const crossNamespace of [true, false]) {
  test(`S3 source routes to endpoint namespace only with declared access (${crossNamespace})`, async () => {
    const fixture = await startS3Fixture((_url, request) => {
      expect(request.headers.get("host")).toBe("minio.storage");
      return new Response(null, { headers: { "content-length": "7" } });
    });
    const forwarded: string[] = [];
    const forward = spyOn(KubernetesClient.prototype, "forward").mockImplementation(async (namespace, target) => {
      forwarded.push(namespace);
      expect(target.host).toBe("minio.storage");
      const local = new URL(fixture.target.endpoint);
      return { host: local.hostname, port: Number(local.port), servername: target.host };
    });
    const f = executor();
    const exec: Executor = { ...f.exec, run: async (args, options) => args[0] === "auth"
      ? { ...ok, command: args, stdout: "yes\n" } : f.exec.run(args, options) };
    const source = s3DataSource("cross-namespace", async () => ({ ...fixture.target, endpoint: "http://minio.storage", bucket: "archive" }));
    const access = { kubernetes: [{ requirement: "required" as const, purpose: "S3 endpoint", rule: {
      verb: "create", resource: "pods/portforward", allNamespaces: crossNamespace,
    } }] };
    const service = { ...logService(), workloads: [], dataSources: [{ id: "s3", kind: "s3" as const, backend: "s3-compatible" as const, access, source }] };
    const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
    const collect = { profileName: "default", kubernetes: { namespace: "demo", namespaceSource: "default" as const, kubeconfigSource: "flag" } };
    try {
      const pending = borrowServiceClient(command, collect, exec, service.name, { access }, source);
      if (!crossNamespace) {
        await expect(pending).rejects.toThrow("未声明 Kubernetes access");
        expect(forwarded).toEqual([]);
      } else {
        const client = await pending;
        expect(forwarded).toEqual(["storage"]);
        expect((await client.access.headObject("archive", "file")).size).toBe(7);
      }
    } finally { await command.disposeClients(); forward.mockRestore(); await fixture.close(); }
  });
}

/** @case id=redis-store-metric-source,desc=`Store and Metric borrow one source and refresh topology`,expect=`one initialization, fresh masters, root-only disposal` */
test("Redis store and metric share source without Pod config reads; each metric sample refreshes masters", async () => {
  const { prepareStoreMetricCollection } = await import("../src/collect/metric/store/collector");
  const { EmbeddedMetricSource } = await import("../src/infra/metric");
  const f = executor();
  const exec: Executor = { ...f.exec, run: async (args, options) => {
    if (args[0] === "get" && ["services", "pods"].includes(args[1]!)) {
      return { ...ok, stdout: '{"items":[]}', command: args };
    }
    return f.exec.run(args, options);
  } };
  let starts = 0, closes = 0, discoveries = 0;
  const visited: string[] = [];
  const client: ServiceRedisClient = {
    target: { endpoints: [{ host: "seed", port: 26379 }], database: 2, useSsl: false,
      timeoutMs: 1000, clusterType: "sentinel", sentinelMasterName: "primary", password: "private-password" },
    topology: async () => ({ clusterType: "sentinel", replicas: [], slotRanges: [], masters: [{ host: `master-${++discoveries}`, port: 6379 }] }),
    access: { connection: async (endpoint, database) => {
      expect(database).toBe(2);
      visited.push(endpoint.host);
      return { endpoint, ping: async () => "PONG", info: async () => ({ connected_clients: 3 }),
        dbSize: async () => 0, command: async () => null, pipeline: async () => [], scan: async () => ({ cursor: "0", keys: [] }) };
    }, close: async () => { throw new Error("Borrower must not close access"); } },
    initialize: async () => { starts++; }, dispose: async () => { closes++; },
  };
  const service = { ...logService("logical"), workloads: [], dataSources: [{ id: "redis", kind: "redis" as const,
    backend: "redis" as const, source: { clientKey: "cache", createClient: () => client } }] };
  const command = new CommandContext({}, undefined, { plugin: logPlugin(service) });
  try {
    const selected = await resolveRedisConfig({ namespace: "demo", service: service.name,
      maxKeys: "1", maxKeysPerSecond: "1", top: "1" }, command, exec, command.plugin.services);
    const metric = await prepareStoreMetricCollection({ plugin: command.plugin, commandContext: command,
      collect: selected!.config.collect, executor: exec, services: [service.name], namespace: "demo", intervalMs: 1000,
      forwarder: {} as import("@compforge/harness-toolbox/kubernetes/service-port-forward").ServicePortForwarder });
    const output = new EmbeddedMetricSource({ retentionMs: 60_000, sampleIntervalMs: 1000 });
    const ingest = spyOn(output, "ingest");
    expect(metric.directCount).toBe(1);
    expect(starts).toBe(1);
    expect(await metric.sample(output)).toEqual([]);
    expect(await metric.sample(output)).toEqual([]);
    expect(visited).toEqual(["master-1", "master-2"]);
    expect(ingest.mock.calls[0]![1]?.labels).toMatchObject({ doctor_service: "logical", doctor_store: "redis" });
    expect(JSON.stringify(ingest.mock.calls)).not.toContain("private-password");
    await metric.close();
    expect(closes).toBe(0);
    ingest.mockRestore();
  } finally { await command.disposeClients(); }
  expect(closes).toBe(1);
});

test("TCP sources keep external endpoints direct and authorize Service forwarding in its own namespace", async () => {
  const { tcpTransports } = await import("@compforge/doctor-plugin");
  const namespaces: string[] = [];
  const forwarded: unknown[] = [];
  const context = {
    target: { namespace: "app" },
    infra: { kubernetes: {
      inNamespace: (namespace: string) => {
        namespaces.push(namespace);
        return { portForward: async (endpoint: unknown) => {
          forwarded.push(endpoint);
          return { host: "127.0.0.1", port: 16379 };
        } };
      },
      podRelay: async () => { throw new Error("relay permission denied"); },
    } },
  } as unknown as import("@compforge/doctor-plugin").PluginClientContext;
  const routes = tcpTransports(context);
  const external = { host: "redis.example.org", port: 6379 };
  expect(await routes[0]!.connect(external)).toEqual(external);
  expect(namespaces).toEqual([]);
  const service = { host: "redis.storage.svc.cluster.local", port: 6379 };
  expect(await routes[0]!.connect(service)).toMatchObject({ host: "127.0.0.1", port: 16379 });
  expect(namespaces).toEqual(["storage"]);
  expect(forwarded).toEqual([service]);
  await expect(routes[1]!.connect(external)).rejects.toThrow("relay permission denied");
});
