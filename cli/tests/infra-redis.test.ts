import { expect, test } from "bun:test";
import {
  collectRedisKeyStats,
  discoverRedisTopology,
  parseRedisInfo,
  RedisAccess,
  RedisConnection,
  type RedisAccessApi,
  type RedisManagedConnection,
} from "../src/infra/redis";

test("Redis keyStats 对完整 keyspace pipeline 采集内存与类型长度", async () => {
  let pipelineCall = 0;
  let scanCall = 0;
  const client: any = {
    endpoint: { host: "redis-0", port: 6379 },
    dbSize: async () => 3,
    scan: async () => {
      scanCall += 1;
      return scanCall === 1
        ? { cursor: "1", keys: ["a", "b"] }
        : { cursor: "0", keys: ["b", "c"] };
    },
    pipeline: async () => {
      pipelineCall += 1;
      return pipelineCall === 1
        ? ["string", "stream", "hash"]
        : [-1, 100, 3, -1, 200, 5, 1_000, 50, 2];
    },
  };

  const result = await collectRedisKeyStats(client, {
    maxKeys: 10,
    maxKeysPerSecond: 100_000,
    scanCount: 100,
    pipelineKeys: 10,
    memorySamples: 5,
  });

  expect(result).toMatchObject({
    totalKeys: 3,
    visitedKeys: 4,
    inspectedKeys: 3,
    scanComplete: true,
  });
  expect(result.keys).toEqual([
    { key: "a", type: "string", ttlMs: -1, memoryBytes: 100, length: 3 },
    { key: "b", type: "stream", ttlMs: -1, memoryBytes: 200, length: 5 },
    { key: "c", type: "hash", ttlMs: 1_000, memoryBytes: 50, length: 2 },
  ]);
});

test("Redis INFO wire 文本在 infra 层转换为结构化值", () => {
  expect(parseRedisInfo([
    "# Memory",
    "used_memory:1024",
    "mem_fragmentation_ratio:1.25",
    "maxmemory_policy:noeviction",
    "# Keyspace",
    "db0:keys=10,expires=4,avg_ttl=1200",
  ].join("\r\n"))).toEqual({
    used_memory: 1024,
    mem_fragmentation_ratio: 1.25,
    maxmemory_policy: "noeviction",
    db0: { keys: 10, expires: 4, avg_ttl: 1200 },
  });
});

test("Redis Cluster 拓扑发现保留每个节点的逻辑 endpoint", async () => {
  const access: RedisAccessApi = {
    connection: async (endpoint) => ({
      endpoint,
      ping: async () => "PONG",
      info: async () => ({ cluster_enabled: 1 }),
      dbSize: async () => 0,
      pipeline: async () => [],
      scan: async () => ({ cursor: "0", keys: [] }),
      command: async (args) => args[0] === "CLUSTER"
        ? [[0, 8191, ["redis-0", 6379], ["redis-0-replica", 6379]], [8192, 16383, ["redis-1", 6379]]]
        : [],
    }),
    close: async () => undefined,
  };
  const topology = await discoverRedisTopology(access, {
    endpoints: [{ host: "redis", port: 6379 }],
    database: 0,
    clusterType: "cluster",
    sentinelHosts: [],
    sentinelMasterName: "mymaster",
  });
  expect(topology.clusterType).toBe("cluster");
  expect(topology.masters).toEqual([
    { host: "redis-0", port: 6379 },
    { host: "redis-1", port: 6379 },
  ]);
  expect(topology.replicas).toEqual([{ host: "redis-0-replica", port: 6379 }]);
});

test("Redis command deadline 淘汰无响应连接，且不使用 idle socket timeout", async () => {
  let options: any;
  let open = true;
  let ready = true;
  let destroyed = 0;
  const client: any = {
    get isOpen() { return open; },
    get isReady() { return ready; },
    on: () => client,
    connect: async () => client,
    ping: () => new Promise<string>(() => undefined),
    destroy: () => {
      open = false;
      ready = false;
      destroyed += 1;
    },
  };
  const connection = await RedisConnection.connect(
    { host: "redis.example.test", port: 6379 },
    { host: "127.0.0.1", port: 16379 },
    { database: 7, useSsl: false, timeoutMs: 20 },
    (received) => {
      options = received;
      return client;
    },
  );

  expect(options.socket.socketTimeout).toBeUndefined();
  expect(options.commandOptions.timeout).toBe(20);
  expect(options.socket.reconnectStrategy(0)).toBe(100);
  expect(options.socket.reconnectStrategy(1)).toBe(200);
  expect(options.socket.reconnectStrategy(2)).toBeFalse();
  await expect(connection.ping()).rejects.toThrow(
    "Redis command timed out after 20ms (redis.example.test:6379)",
  );
  expect(destroyed).toBe(1);
  connection.close();
  expect(destroyed).toBe(1);
});

test("RedisAccess 复用健康连接，并淘汰失效连接", async () => {
  const states: Array<{ ready: boolean; closes: number }> = [];
  const access = new RedisAccess(
    async (endpoint) => endpoint,
    { useSsl: false, timeoutMs: 5_000 },
    async (endpoint): Promise<RedisManagedConnection> => {
      const state = { ready: true, closes: 0 };
      states.push(state);
      return {
        endpoint,
        get isReady() { return state.ready; },
        ping: async () => "PONG",
        info: async () => ({}),
        dbSize: async () => 0,
        command: async () => [],
        pipeline: async () => [],
        scan: async () => ({ cursor: "0", keys: [] }),
        close: () => {
          state.ready = false;
          state.closes += 1;
        },
      };
    },
  );
  const endpoint = { host: "redis.example.test", port: 6379 };

  const first = await access.connection(endpoint, 7);
  expect(await access.connection(endpoint, 7)).toBe(first);
  states[0]!.ready = false;
  const second = await access.connection(endpoint, 7);
  expect(second).not.toBe(first);
  expect(states).toHaveLength(2);
  expect(states[0]!.closes).toBe(1);

  await access.close();
  await access.close();
  expect(states[1]!.closes).toBe(1);
});

test("RedisAccess 建连失败后不缓存 rejected promise", async () => {
  let attempts = 0;
  const access = new RedisAccess(
    async (endpoint) => endpoint,
    { useSsl: false, timeoutMs: 5_000 },
    async (endpoint): Promise<RedisManagedConnection> => {
      attempts += 1;
      if (attempts === 1) throw new Error("connect failed");
      return {
        endpoint,
        isReady: true,
        ping: async () => "PONG",
        info: async () => ({}),
        dbSize: async () => 0,
        command: async () => [],
        pipeline: async () => [],
        scan: async () => ({ cursor: "0", keys: [] }),
        close: () => undefined,
      };
    },
  );
  const endpoint = { host: "redis.example.test", port: 6379 };

  await expect(access.connection(endpoint, 0)).rejects.toThrow("connect failed");
  expect(await access.connection(endpoint, 0)).toBeDefined();
  expect(attempts).toBe(2);
});
