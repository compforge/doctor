import type { RedisAccessApi, RedisCredentials, RedisEndpoint } from "./client";

export interface RedisTopologyConfig extends RedisCredentials {
  endpoints: RedisEndpoint[];
  database: number;
  clusterType: "single" | "sentinel" | "cluster";
  sentinelHosts: RedisEndpoint[];
  sentinelMasterName: string;
  sentinelUsername?: string;
  sentinelPassword?: string;
}

export interface RedisSlotRange {
  start: number;
  end: number;
  master: RedisEndpoint;
  replicas: RedisEndpoint[];
}

export interface RedisTopology {
  clusterType: "single" | "sentinel" | "cluster";
  masters: RedisEndpoint[];
  replicas: RedisEndpoint[];
  slotRanges: RedisSlotRange[];
}

function text(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
}

function endpoint(value: unknown, fallbackHost?: string): RedisEndpoint {
  if (!Array.isArray(value) || value.length < 2) throw new Error("Redis 拓扑 endpoint 格式无效");
  const host = text(value[0]) || fallbackHost || "";
  const port = Number(value[1]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Redis 拓扑 endpoint 无效：${host || "(empty)"}:${text(value[1])}`);
  }
  return { host, port };
}

function sentinelRows(value: unknown): Record<string, string>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const record: Record<string, string> = {};
    for (let index = 0; index + 1 < row.length; index += 2) {
      record[text(row[index])] = text(row[index + 1]);
    }
    return [record];
  });
}

async function discoverSentinel(access: RedisAccessApi, config: RedisTopologyConfig): Promise<RedisTopology> {
  const sentinels = config.sentinelHosts.length ? config.sentinelHosts : config.endpoints;
  let lastError: unknown;
  for (const sentinel of sentinels) {
    try {
      const client = await access.connection(sentinel, 0, {
        username: config.sentinelUsername,
        password: config.sentinelPassword,
      });
      const master = endpoint(await client.command([
        "SENTINEL", "GET-MASTER-ADDR-BY-NAME", config.sentinelMasterName,
      ]));
      const replicas = sentinelRows(await client.command([
        "SENTINEL", "REPLICAS", config.sentinelMasterName,
      ])).filter((row) => !row.flags?.includes("s_down") && !row.flags?.includes("o_down"))
        .flatMap((row) => {
          const port = Number(row.port);
          return row.ip && Number.isInteger(port) && port > 0 && port <= 65_535
            ? [{ host: row.ip, port }]
            : [];
        });
      return { clusterType: "sentinel", masters: [master], replicas, slotRanges: [] };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("没有可用的 Redis Sentinel endpoint");
}

async function discoverSeed(access: RedisAccessApi, config: RedisTopologyConfig): Promise<RedisTopology> {
  let lastError: unknown;
  for (const seed of config.endpoints) {
    try {
      const client = await access.connection(seed, 0);
      await client.ping();
      const clusterInfo = await client.info("cluster");
      if (config.clusterType !== "cluster" && Number(clusterInfo.cluster_enabled ?? 0) !== 1) {
        return { clusterType: "single", masters: [seed], replicas: [], slotRanges: [] };
      }
      const reply = await client.command(["CLUSTER", "SLOTS"]);
      if (!Array.isArray(reply)) throw new Error("CLUSTER SLOTS 返回格式无效");
      const masters = new Map<string, RedisEndpoint>();
      const replicas = new Map<string, RedisEndpoint>();
      const slotRanges = reply.map((row): RedisSlotRange => {
        if (!Array.isArray(row) || row.length < 3) throw new Error("CLUSTER SLOTS row 格式无效");
        const master = endpoint(row[2], seed.host);
        masters.set(`${master.host}:${master.port}`, master);
        const rowReplicas = row.slice(3).map((item) => endpoint(item, seed.host));
        for (const replica of rowReplicas) replicas.set(`${replica.host}:${replica.port}`, replica);
        return { start: Number(row[0]), end: Number(row[1]), master, replicas: rowReplicas };
      });
      return {
        clusterType: "cluster",
        masters: [...masters.values()],
        replicas: [...replicas.values()],
        slotRanges,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("没有可用的 Redis endpoint");
}

export function discoverRedisTopology(
  access: RedisAccessApi,
  config: RedisTopologyConfig,
): Promise<RedisTopology> {
  return config.clusterType === "sentinel"
    ? discoverSentinel(access, config)
    : discoverSeed(access, config);
}
