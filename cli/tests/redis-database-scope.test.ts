import { expect, test } from "bun:test";
import type { EvidenceBundle } from "../src/collect/evidence";
import {
  selectRedisDatabaseScope,
  type RedisConfig,
} from "../src/collect/redis/config";
import type { RedisCommandContext } from "../src/collect/redis/context";
import { CommandContext } from "../src/command";
import { confirmRedisTarget } from "../src/collect/redis/preparation";
import { collectRedisRuntime, discoverRedisDatabases } from "../src/collect/redis/probe/collector";
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
    redisDatabaseScope: { mode: "all", databases: [0, 7] },
    bundle: {} as EvidenceBundle,
    log: () => undefined,
  } satisfies RedisCommandContext;

  expect(await discoverRedisDatabases(context)).toEqual({
    clusterType: "single",
    databases: [0, 7],
  });

  const output = await collectRedisRuntime(context, {
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
