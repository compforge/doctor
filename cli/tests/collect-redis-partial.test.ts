import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle } from "../src/collect/evidence";
import { runProbes } from "../src/collect/probe-engine";
import type { RedisConfig } from "../src/collect/redis/config";
import type { RedisCommandContext } from "../src/collect/redis/context";
import { CommandContext } from "../src/command";
import { buildRedisCoverage, redisDetectors } from "../src/collect/redis/detector";
import { buildRedisInspectionFacts } from "../src/collect/redis/fact/model";
import { buildRedisEvidence } from "../src/collect/redis/model";
import { collectRedisRuntime } from "../src/collect/redis/probe/collector";
import { makeRedisRuntimeProbe } from "../src/collect/redis/probe/runtime";
import { buildRedisHtml, buildRedisMarkdown } from "../src/collect/redis/render";
import type { RedisAccessApi, RedisConnectionApi } from "../src/infra/redis";

test("Redis keyspace 抽样失败时保留拓扑和节点证据，并把 Probe 记为 partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-redis-partial-test-"));
  try {
    const endpoint = { host: "redis.example.com", port: 6379 };
    const connection: RedisConnectionApi = {
      endpoint,
      ping: async () => "PONG",
      info: async (section) => section === "cluster"
        ? { cluster_enabled: 0 }
        : {
            used_memory: 100,
            maxmemory: 1_000,
            db7: { keys: 100, expires: 0, avg_ttl: 0 },
          },
      dbSize: async () => 100,
      command: async () => undefined,
      pipeline: async () => [],
      scan: async () => { throw new Error("SCAN timed out"); },
    };
    const access: RedisAccessApi = {
      connection: async () => connection,
      close: async () => undefined,
    };
    const bundle = new EvidenceBundle(root, [{
      id: "redis-probe",
      title: "Redis runtime",
      risk: "observe",
    }]);
    const context = {
      command: new CommandContext({}),
      config: {} as RedisConfig,
      exec: {} as RedisCommandContext["exec"],
      execTarget: { pod: "app-0" },
      redisAccess: access,
      redisTarget: {
        endpoints: [[endpoint.host, endpoint.port]],
        database: 7,
        useSsl: false,
        clusterType: "single",
        timeout: 5,
        sentinelHosts: [],
        sentinelMasterName: "mymaster",
        endpointSource: "service-env",
        credentialSource: "service-env",
      },
      bundle,
      log: () => undefined,
    } satisfies RedisCommandContext;
    const facts = buildRedisInspectionFacts({
      endpoints: [[endpoint.host, endpoint.port]],
      database: 7,
      useSsl: false,
      clusterType: "single",
      endpointSource: "service-env",
      credentialSource: "service-env",
    }, { namespace: "ns", pod: "app-0" }, { available: true });
    const config = {
      scan: {
        mode: "sample",
        maxKeys: 10,
        maxKeysPerSecond: 100,
        scanCount: 100,
        pipelineKeys: 50,
        top: 20,
        showKeyNames: false,
        keyStats: false,
      },
    } as RedisConfig;

    const observations = await runProbes(
      [makeRedisRuntimeProbe()],
      context,
      facts,
      config,
    );

    expect(observations.map((item) => item.kind)).toEqual(["overview", "node"]);
    expect(observations[0]).toMatchObject({
      kind: "overview",
      partialReason: "redis.example.com:6379 db7 keyspace 抽样：SCAN timed out",
    });
    expect(bundle.getSteps()).toEqual([expect.objectContaining({
      id: "redis-probe",
      status: "partial",
      reason: "redis.example.com:6379 db7 keyspace 抽样：SCAN timed out",
    })]);
    const evidence = buildRedisEvidence(observations, facts);
    const diagnosis = {
      evidence,
      findings: redisDetectors.flatMap((detector) => detector(evidence)),
      coverage: buildRedisCoverage(evidence),
    };
    expect(buildRedisMarkdown({ endpoint: "redis://redis.example.com:6379/7", endpoint_source: "test" }, diagnosis))
      .toContain("采集状态: `partial`");
    expect(buildRedisHtml({ endpoint: "redis://redis.example.com:6379/7", endpoint_source: "test" }, diagnosis))
      .toContain("采集状态: partial（部分完成；缺失证据及影响见诊断覆盖度）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Redis replica 读取失败进入 partial 原因", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-redis-replica-partial-test-"));
  try {
    const master = { host: "redis-master.example.com", port: 6379 };
    const replica = { host: "redis-replica.example.com", port: 6380 };
    const masterConnection: RedisConnectionApi = {
      endpoint: master,
      ping: async () => "PONG",
      info: async (section) => section === "cluster"
        ? { cluster_enabled: 1 }
        : { used_memory: 100, maxmemory: 1_000 },
      dbSize: async () => 100,
      command: async (args) => args[0] === "CLUSTER"
        ? [[0, 16_383, [master.host, master.port], [replica.host, replica.port]]]
        : undefined,
      pipeline: async () => [],
      scan: async () => ({ cursor: "0", keys: [] }),
    };
    const replicaConnection: RedisConnectionApi = {
      ...masterConnection,
      endpoint: replica,
      info: async () => { throw new Error("replica INFO timed out"); },
    };
    const access: RedisAccessApi = {
      connection: async (endpoint) => endpoint.port === replica.port
        ? replicaConnection
        : masterConnection,
      close: async () => undefined,
    };
    const context = {
      command: new CommandContext({}),
      config: {} as RedisConfig,
      exec: {} as RedisCommandContext["exec"],
      execTarget: { pod: "app-0" },
      redisAccess: access,
      redisTarget: {
        endpoints: [[master.host, master.port]],
        database: 7,
        useSsl: false,
        clusterType: "cluster",
        timeout: 5,
        sentinelHosts: [],
        sentinelMasterName: "mymaster",
        endpointSource: "service-env",
        credentialSource: "service-env",
      },
      bundle: new EvidenceBundle(root),
      log: () => undefined,
    } satisfies RedisCommandContext;

    const output = await collectRedisRuntime(context, {
      mode: "quick",
      maxKeys: 10,
      maxKeysPerSecond: 100,
      scanCount: 100,
      pipelineKeys: 50,
      top: 20,
      showKeyNames: false,
    });

    expect(output.error).toBe("redis-replica.example.com:6380 节点状态：replica INFO timed out");
    expect(output.replicas[0]?.error).toBe("replica INFO timed out");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Redis 基础 Probe 完全失败时记为 failed 后继续抛出", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-redis-failed-test-"));
  try {
    const endpoint = { host: "redis.example.com", port: 6379 };
    const bundle = new EvidenceBundle(root, [{
      id: "redis-probe",
      title: "Redis runtime",
      risk: "observe",
    }]);
    const context = {
      command: new CommandContext({}),
      config: {} as RedisConfig,
      exec: {} as RedisCommandContext["exec"],
      execTarget: { pod: "app-0" },
      redisAccess: {
        connection: async () => { throw new Error("connect timed out"); },
        close: async () => undefined,
      },
      redisTarget: {
        endpoints: [[endpoint.host, endpoint.port]],
        database: 7,
        useSsl: false,
        clusterType: "single",
        timeout: 5,
        sentinelHosts: [],
        sentinelMasterName: "mymaster",
        endpointSource: "service-env",
        credentialSource: "service-env",
      },
      bundle,
      log: () => undefined,
    } satisfies RedisCommandContext;
    const facts = buildRedisInspectionFacts({
      endpoints: [[endpoint.host, endpoint.port]],
      database: 7,
      useSsl: false,
      clusterType: "single",
      endpointSource: "service-env",
      credentialSource: "service-env",
    }, { namespace: "ns", pod: "app-0" }, { available: true });
    const config = {
      scan: {
        mode: "quick",
        maxKeys: 10,
        maxKeysPerSecond: 100,
        scanCount: 100,
        pipelineKeys: 50,
        top: 20,
        showKeyNames: false,
        keyStats: false,
      },
    } as RedisConfig;

    await expect(runProbes([makeRedisRuntimeProbe()], context, facts, config))
      .rejects.toThrow("connect timed out");
    expect(bundle.getSteps()).toEqual([expect.objectContaining({
      id: "redis-probe",
      status: "failed",
      reason: "connect timed out",
    })]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Redis 多 master 仅部分扫描成功时 coverage 保持 partial", () => {
  const facts = buildRedisInspectionFacts({
    endpoints: [["redis-1.example.com", 6379]],
    database: 7,
    useSsl: false,
    clusterType: "cluster",
    endpointSource: "service-env",
    credentialSource: "service-env",
  }, { namespace: "ns", pod: "app-0" }, { available: true });
  const evidence = buildRedisEvidence([
    {
      id: "overview",
      kind: "overview",
      clusterType: "cluster",
      scanMode: "sample",
      databaseScope: "single",
      selectedDatabases: [7],
      selectedDatabase: 7,
      slotRanges: [],
      partialReason: "redis-2.example.com:6379 keyspace 抽样：SCAN timed out",
    },
    ...["redis-1.example.com", "redis-2.example.com"].map((host) => ({
      id: `node:${host}:6379`,
      kind: "node" as const,
      node: {
        host,
        port: 6379,
        role: "master",
        selected_database: 7,
        databases: [],
        info: { used_memory: 100, maxmemory: 1_000 },
      },
    })),
    {
      id: "keyspace:redis-1.example.com:6379:db7",
      kind: "keyspace",
      scan: {
        node: { host: "redis-1.example.com", port: 6379 },
        database: 7,
        scanned_keys: 10,
        scan_complete: false,
        sampled_memory_bytes: 100,
        average_sampled_bytes_per_key: 10,
        types: [],
        prefixes: [],
        top_prefixes_by_key_count: [],
        ttl_buckets: {},
        top_slots: [],
        top_keys: [],
        top_streams: [],
      },
    },
  ], facts);

  expect(buildRedisCoverage(evidence)).toContainEqual({
    goal: "redis-memory-distribution",
    status: "partial",
    missingEvidence: [
      "Redis keyspace 抽样（redis-2.example.com:6379 keyspace 抽样：SCAN timed out）",
    ],
  });
});
