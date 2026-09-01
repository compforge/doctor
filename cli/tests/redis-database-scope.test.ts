import { expect, test } from "bun:test";
import type { EvidenceBundle } from "../src/collect/evidence";
import { runInspects } from "../src/collect/inspect-engine";
import {
  selectRedisDatabaseScope,
  type RedisConfig,
} from "../src/collect/redis/config";
import type { RedisCommandContext } from "../src/collect/redis/context";
import { CommandContext } from "../src/command";
import { confirmRedisTarget } from "../src/collect/redis/preparation";
import { makeRedisDatabaseScopeInspect } from "../src/collect/redis/fact/database-scope";
import {
  buildRedisInspectionFacts,
  type RedisInspectionFacts,
} from "../src/collect/redis/fact/model";
import { collectRedisRuntime } from "../src/collect/redis/probe/collector";
import type { RedisAccessApi, RedisConnectionApi } from "../src/infra/redis";
import { resolveRedisOutputPath } from "../src/collect/redis";

test("Redis 默认双交付接受 tar.gz 输出路径", () => {
  expect(resolveRedisOutputPath("report.tar.gz", "ignored", "default")).toBe("report.html");
});

test("Redis database 范围默认覆盖所有有数据的 DB，显式参数只选单个 DB", async () => {
  await expect(selectRedisDatabaseScope([7, 0, 7], "single", undefined, false)).resolves.toEqual({
    mode: "all",
    databases: [0, 7],
  });
  await expect(selectRedisDatabaseScope([0, 7], "single", 3, false)).resolves.toEqual({
    mode: "single",
    databases: [3],
  });
  await expect(selectRedisDatabaseScope([0], "cluster", 7, false))
    .rejects.toThrow("Redis Cluster 只支持 database 0");
});

test("Service 配置中的 database 只作为连接默认值，不覆盖用户诊断范围", async () => {
  const confirmed = await confirmRedisTarget(
    {
      exec: async () => ({
        ok: true,
        stdout: "REDIS_HOST=redis.example.com\nREDIS_DB=7\n",
        stderr: "",
        exitCode: 0,
        command: ["kubectl", "exec"],
      }),
    } as unknown as RedisCommandContext["exec"],
    { pod: "app-0", container: "app" },
    { requestedDatabase: 3 } as RedisConfig,
  );

  expect(confirmed.target?.database).toBe(7);
});

test("Redis sample 总预算在同一 master 的多个 DB 间分配", async () => {
  const endpoint = { host: "redis.example.com", port: 6379 };
  const connection = (database: number): RedisConnectionApi => ({
    endpoint,
    ping: async () => "PONG",
    info: async (section) => section === "cluster"
      ? { cluster_enabled: 0 }
      : {
          used_memory: 100,
          maxmemory: 1_000,
          db0: { keys: 2, expires: 0, avg_ttl: 0 },
          db7: { keys: 2, expires: 1, avg_ttl: 100 },
        },
    dbSize: async () => 2,
    command: async () => undefined,
    scan: async () => ({ cursor: "0", keys: [`db${database}:a`, `db${database}:b`] }),
    pipeline: async (commands) => commands.map((command) => {
      if (command[0] === "TYPE") return "string";
      if (command[0] === "PTTL") return -1;
      if (command[0] === "MEMORY") return 100;
      return 1;
    }),
  });
  const access: RedisAccessApi = {
    connection: async (_endpoint, database) => connection(database),
    close: async () => undefined,
  };
  const context = {
    command: new CommandContext({}),
    config: {
      scan: { mode: "sample" },
    } as RedisConfig,
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
    bundle: {} as EvidenceBundle,
    log: () => undefined,
  } satisfies RedisCommandContext;

  const targetFacts = buildRedisInspectionFacts({
    endpoints: [[endpoint.host, endpoint.port]],
    database: 7,
    useSsl: false,
    clusterType: "single",
    endpointSource: "service-env",
    credentialSource: "service-env",
  }, { namespace: "ns", pod: "app-0" }, { available: true });
  const { databaseScope: _defaultScope, ...prerequisiteFacts } = targetFacts;
  const facts = await runInspects<RedisInspectionFacts, RedisCommandContext>([
    {
      id: "redis-target",
      run: async () => prerequisiteFacts,
    },
    makeRedisDatabaseScopeInspect({
      selectScope: (databases, clusterType, requestedDatabase) =>
        selectRedisDatabaseScope(databases, clusterType, requestedDatabase, false),
    }),
  ], context);

  expect(facts.databaseScope).toEqual(expect.objectContaining({
    status: "collected",
    clusterType: "single",
    clusterTypeSource: "runtime",
    discoveredDatabases: [0, 7],
    mode: "all",
    databases: [0, 7],
  }));
  expect(Object.isFrozen(facts.databaseScope)).toBe(true);
  if (facts.databaseScope.status !== "collected") throw new Error("scope Fact should be collected");

  const output = await collectRedisRuntime(context, facts.databaseScope, {
    mode: "sample",
    maxKeys: 4,
    maxKeysPerSecond: 100_000,
    scanCount: 100,
    pipelineKeys: 50,
    top: 20,
    showKeyNames: false,
  });

  expect(output.database_scope).toBe("all");
  expect(output.selected_databases).toEqual([0, 7]);
  expect(output.scans.map((scan) => [scan.database, scan.scanned_keys])).toEqual([[0, 2], [7, 2]]);
});

test("Redis database scope Inspect 保留用户取消原因，供 Core 停在 Probe 之前", async () => {
  const targetFacts = buildRedisInspectionFacts({
    endpoints: [["redis.example.com", 6379]],
    database: 0,
    useSsl: false,
    clusterType: "single",
    endpointSource: "service-env",
    credentialSource: "service-env",
  }, { namespace: "ns", pod: "app-0" }, { available: true });
  const { databaseScope: _defaultScope, ...prerequisiteFacts } = targetFacts;
  const inspect = makeRedisDatabaseScopeInspect({ selectScope: async () => undefined });
  const context = {
    config: { scan: { mode: "sample" } } as RedisConfig,
    redisTarget: {
      endpoints: [["redis.example.com", 6379]],
      database: 0,
      useSsl: false,
      clusterType: "single",
      timeout: 5,
      sentinelHosts: [],
      sentinelMasterName: "mymaster",
      endpointSource: "service-env",
      credentialSource: "service-env",
    },
    redisAccess: {
      connection: async () => ({
        endpoint: { host: "redis.example.com", port: 6379 },
        ping: async () => "PONG",
        info: async (section?: string) => section === "cluster"
          ? { cluster_enabled: 0 }
          : { db0: { keys: 1 } },
        dbSize: async () => 1,
        command: async () => undefined,
        scan: async () => ({ cursor: "0", keys: [] }),
        pipeline: async () => [],
      }),
      close: async () => undefined,
    },
    log: () => undefined,
  } as unknown as RedisCommandContext;

  const produced = await inspect.run(context, prerequisiteFacts);

  expect(inspect.dependsOn).toEqual(["redis-target"]);
  expect(produced.databaseScope).toEqual(expect.objectContaining({
    status: "unavailable",
    reason: "用户取消 Redis database 范围选择",
    cause: "cancelled",
  }));
});
