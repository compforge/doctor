import { createHash } from "node:crypto";
import {
  collectRedisKeyStats,
  discoverRedisTopology,
  type RedisConnectionApi,
  type RedisEndpoint,
  type RedisTopologyConfig,
} from "../../../infra/redis";
import type { RedisCommandContext } from "../context";
import type { RedisGroup, RedisKey, RedisNode, RedisScan } from "../model";
import type { RedisPressureProbeOutput, RedisRuntimeProbeOutput } from "./runtime";
import { sleep } from "../../../infra/host/process";

export { redisGroupedSampleSizes } from "../../../infra/redis";

interface ScanOptions {
  mode: "quick" | "sample";
  maxKeys: number;
  maxKeysPerSecond: number;
  scanCount: number;
  pipelineKeys: number;
  top: number;
  showKeyNames: boolean;
}

export const REDIS_SKEW_KEY_STATS_FULL_SCAN_MAX_KEYS = 50_000;

const INFO_FIELDS = [
  "redis_version", "uptime_in_seconds", "used_memory", "used_memory_human",
  "used_memory_rss", "used_memory_rss_human", "used_memory_dataset",
  "used_memory_dataset_perc", "mem_not_counted_for_evict", "mem_fragmentation_ratio",
  "maxmemory", "maxmemory_human", "maxmemory_policy", "connected_clients", "blocked_clients",
  "total_connections_received", "total_commands_processed", "instantaneous_ops_per_sec",
  "keyspace_hits", "keyspace_misses", "evicted_keys", "expired_keys",
  "current_eviction_exceeded_time", "total_eviction_exceeded_time", "errorstat_OOM",
  "rejected_connections", "role", "connected_slaves", "master_host", "master_port",
  "master_link_status", "aof_enabled", "aof_current_size", "aof_base_size",
  "rdb_last_save_time", "rdb_last_bgsave_status", "loading", "cluster_enabled",
] as const;

function topologyConfig(ctx: RedisCommandContext): RedisTopologyConfig {
  const target = ctx.redisTarget;
  if (!target) throw new Error("Redis Probe 在执行态目标未就绪时被调用");
  return {
    endpoints: target.endpoints.map(([host, port]) => ({ host, port })),
    database: target.database,
    username: target.username,
    password: target.password,
    clusterType: target.clusterType,
    sentinelHosts: target.sentinelHosts.map(([host, port]) => ({ host, port })),
    sentinelMasterName: target.sentinelMasterName,
    sentinelUsername: target.sentinelUsername,
    sentinelPassword: target.sentinelPassword,
  };
}

function selectedInfo(info: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(INFO_FIELDS.flatMap((key) => key in info ? [[key, info[key]]] : []));
}

function databases(info: Record<string, unknown>) {
  return Object.entries(info).flatMap(([name, value]) => {
    if (!/^db\d+$/.test(name) || !value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    return [{
      database: Number(name.slice(2)),
      keys: Number(row.keys ?? 0),
      expires: Number(row.expires ?? 0),
      average_ttl_ms: Number(row.avg_ttl ?? 0),
    }];
  }).sort((left, right) => left.database - right.database);
}

export async function discoverRedisDatabases(
  ctx: RedisCommandContext,
): Promise<{ clusterType: "single" | "sentinel" | "cluster"; databases: number[] }> {
  const access = ctx.redisAccess;
  const target = ctx.redisTarget;
  if (!access || !target) throw new Error("Redis 采集准备未完成");
  const topology = await discoverRedisTopology(access, topologyConfig(ctx));
  if (topology.clusterType === "cluster") return { clusterType: "cluster", databases: [0] };
  const discovered = new Set<number>();
  for (const endpoint of topology.masters) {
    const info = await (await access.connection(endpoint, target.database)).info("keyspace");
    for (const database of databases(info)) discovered.add(database.database);
  }
  return {
    clusterType: topology.clusterType,
    databases: [...discovered].sort((left, right) => left - right),
  };
}

async function nodeObservation(
  client: RedisConnectionApi,
  endpoint: RedisEndpoint,
  role: "master" | "replica",
  database: number,
): Promise<RedisNode> {
  const info = await client.info();
  let dbsize: number | null = null;
  try {
    dbsize = await client.dbSize();
  } catch {
    // INFO 仍是有效节点证据，DBSIZE 权限不足不应丢掉整行。
  }
  return {
    ...endpoint,
    role,
    selected_database: database,
    databases: databases(info),
    dbsize,
    info: selectedInfo(info),
  };
}

function counter(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const match = value.match(/(?:^|,)count=(\d+)/);
    return match ? Number(match[1]) : Number(value) || 0;
  }
  return 0;
}

function crc16(value: Buffer): number {
  let crc = 0;
  for (const byte of value) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc;
}

function keySlot(key: string): number {
  const open = key.indexOf("{");
  const close = open >= 0 ? key.indexOf("}", open + 1) : -1;
  const hashKey = open >= 0 && close > open + 1 ? key.slice(open + 1, close) : key;
  return crc16(Buffer.from(hashKey)) % 16_384;
}

function ttlBucket(ttl: number): string {
  if (ttl === -1) return "no_ttl";
  if (ttl < 0) return "expired_or_missing";
  if (ttl <= 3_600_000) return "le_1h";
  if (ttl <= 86_400_000) return "le_1d";
  if (ttl <= 7 * 86_400_000) return "le_7d";
  return "gt_7d";
}

function redactKey(key: string, show: boolean): string {
  if (show) return key;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return key.includes(":") ? `${key.split(":", 1)[0]}:* [sha256:${digest}]` : `[sha256:${digest}]`;
}

function aggregate(group: Map<string, RedisGroup>, name: string, memory: number, noTtl: boolean): void {
  const row = group.get(name) ?? {
    name, count: 0, memory_bytes: 0, no_ttl_count: 0, no_ttl_memory_bytes: 0,
  };
  row.count += 1;
  row.memory_bytes += memory;
  if (noTtl) {
    row.no_ttl_count += 1;
    row.no_ttl_memory_bytes += memory;
  }
  group.set(name, row);
}

async function scanMaster(
  client: RedisConnectionApi,
  node: RedisEndpoint,
  database: number,
  options: ScanOptions,
  limit: number,
  progress: (line: string) => void,
): Promise<RedisScan> {
  const types = new Map<string, RedisGroup>();
  const prefixes = new Map<string, RedisGroup>();
  const ttl: Record<string, number> = {};
  const slots = new Map<number, { slot: number; count: number; memory_bytes: number }>();
  const keys: RedisKey[] = [];
  const streams: Array<RedisKey & { length: number | null }> = [];
  let scanned = 0;
  let sampledMemory = 0;
  const reportEvery = Math.max(options.pipelineKeys, Math.min(1_000, Math.max(1, Math.floor(limit / 10))));
  let lastSelected = 0;
  let lastReported = 0;
  const keyStats = await collectRedisKeyStats(client, {
    maxKeys: limit,
    maxKeysPerSecond: options.maxKeysPerSecond,
    scanCount: options.scanCount,
    pipelineKeys: options.pipelineKeys,
    memorySamples: 5,
    onSelectionProgress: (selected) => {
      if (selected - lastSelected >= reportEvery || selected === limit) {
        progress(`已选取 ${node.host}:${node.port} db${database} 的 ${selected}/${limit} 个 key`);
        lastSelected = selected;
      }
    },
    onProgress: (inspected) => {
      if (inspected - lastReported >= reportEvery) {
        progress(`已检查 ${node.host}:${node.port} db${database} 的 ${inspected}/${limit} 个 key`);
        lastReported = inspected;
      }
    },
  });
  for (const record of keyStats.keys) {
    scanned += 1;
    sampledMemory += record.memoryBytes;
    aggregate(types, record.type, record.memoryBytes, record.ttlMs === -1);
    const prefix = record.key.includes(":") ? `${record.key.split(":", 1)[0]}:*` : "<no-prefix>";
    aggregate(prefixes, prefix, record.memoryBytes, record.ttlMs === -1);
    const bucket = ttlBucket(record.ttlMs);
    ttl[bucket] = (ttl[bucket] ?? 0) + 1;
    const slot = keySlot(record.key);
    const slotRow = slots.get(slot) ?? { slot, count: 0, memory_bytes: 0 };
    slotRow.count += 1;
    slotRow.memory_bytes += record.memoryBytes;
    slots.set(slot, slotRow);
    const item: RedisKey = {
      key: redactKey(record.key, options.showKeyNames), type: record.type,
      memory_bytes: record.memoryBytes, ttl_ms: record.ttlMs, slot, length: record.length,
    };
    keys.push(item);
    if (record.type === "stream") streams.push({ ...item, length: record.length });
  }
  const top = <T extends { memory_bytes: number }>(rows: T[]) =>
    rows.sort((left, right) => right.memory_bytes - left.memory_bytes).slice(0, options.top);
  const prefixesByKeyCount = [...prefixes.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, options.top)
    .map(({ name, count }) => ({ name, count }));
  return {
    node, database, scanned_keys: scanned, scan_complete: keyStats.scanComplete,
    sampled_memory_bytes: sampledMemory,
    average_sampled_bytes_per_key: scanned ? Math.round(sampledMemory / scanned * 100) / 100 : 0,
    types: top([...types.values()]), prefixes: top([...prefixes.values()]),
    top_prefixes_by_key_count: prefixesByKeyCount, ttl_buckets: ttl,
    top_slots: top([...slots.values()]), top_keys: top(keys), top_streams: top(streams),
  };
}

export async function collectRedisRuntime(
  ctx: RedisCommandContext,
  options: ScanOptions,
): Promise<RedisRuntimeProbeOutput> {
  const access = ctx.redisAccess;
  const target = ctx.redisTarget;
  if (!access || !target) throw new Error("Redis 采集准备未完成");
  ctx.log("[collect] 正在发现 Redis 拓扑…");
  const topology = await discoverRedisTopology(access, topologyConfig(ctx));
  ctx.log(`[collect] 拓扑发现完成：${topology.clusterType}，${topology.masters.length} 个 master，${topology.replicas.length} 个 replica`);
  const errors: string[] = [];
  const databaseScope = ctx.redisDatabaseScope ?? { mode: "single" as const, databases: [target.database] };
  const masters: RedisNode[] = [];
  for (const [index, endpoint] of topology.masters.entries()) {
    ctx.log(`[collect] 正在读取 master ${index + 1}/${topology.masters.length}（${endpoint.host}:${endpoint.port}）…`);
    try {
      masters.push(await nodeObservation(await access.connection(endpoint, target.database), endpoint, "master", target.database));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${endpoint.host}:${endpoint.port} 节点状态：${reason}`);
      masters.push({
        ...endpoint,
        role: "master",
        selected_database: target.database,
        databases: [],
        error: reason,
      });
    }
  }
  const replicas: RedisNode[] = [];
  for (const [index, endpoint] of topology.replicas.entries()) {
    ctx.log(`[collect] 正在读取 replica ${index + 1}/${topology.replicas.length}（${endpoint.host}:${endpoint.port}）…`);
    try {
      replicas.push(await nodeObservation(await access.connection(endpoint, target.database), endpoint, "replica", target.database));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${endpoint.host}:${endpoint.port} 节点状态：${reason}`);
      replicas.push({
        ...endpoint,
        role: "replica",
        selected_database: target.database,
        databases: [],
        error: reason,
      });
    }
  }
  const scans: RedisScan[] = [];
  if (options.mode === "sample") {
    const targets = topology.masters.flatMap((endpoint) =>
      databaseScope.databases.map((database) => ({ endpoint, database }))
    );
    const perTarget = Math.floor(options.maxKeys / Math.max(1, targets.length));
    const remainder = options.maxKeys % Math.max(1, targets.length);
    for (const [index, { endpoint, database }] of targets.entries()) {
      const limit = perTarget + (index < remainder ? 1 : 0);
      try {
        scans.push(await scanMaster(
          await access.connection(endpoint, database), endpoint, database,
          options, limit, (line) => ctx.log(`[collect] ${line}`),
        ));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push(`${endpoint.host}:${endpoint.port} db${database} keyspace 抽样：${reason}`);
      }
    }
  }
  return {
    cluster_type: topology.clusterType,
    database_scope: databaseScope.mode,
    selected_databases: databaseScope.databases,
    selected_database: databaseScope.mode === "single" ? databaseScope.databases[0] : undefined,
    masters,
    replicas,
    slot_ranges: topology.slotRanges,
    scan_mode: options.mode,
    scans,
    error: errors.length ? errors.join("；") : undefined,
  };
}

export async function collectRedisMasterKeyStats(
  ctx: RedisCommandContext,
  node: RedisEndpoint,
  database: number,
  options: ScanOptions,
  targetCount: number,
): Promise<RedisScan> {
  const access = ctx.redisAccess;
  const target = ctx.redisTarget;
  if (!access || !target) throw new Error("Redis 采集准备未完成");
  const client = await access.connection(node, database);
  const totalKeys = Math.max(0, Number(await client.dbSize()));
  const doubledPerTarget = Math.ceil(options.maxKeys / Math.max(1, targetCount)) * 2;
  const limit = totalKeys <= REDIS_SKEW_KEY_STATS_FULL_SCAN_MAX_KEYS
    ? totalKeys
    : Math.min(totalKeys, doubledPerTarget);
  return scanMaster(
    client,
    node,
    database,
    options,
    limit,
    (line) => ctx.log(`[collect] ${line}`),
  );
}

export async function collectRedisPressure(
  ctx: RedisCommandContext,
  seconds: 1 | 10,
): Promise<RedisPressureProbeOutput> {
  const access = ctx.redisAccess;
  const target = ctx.redisTarget;
  if (!access || !target) throw new Error("Redis 采集准备未完成");
  const topology = await discoverRedisTopology(access, topologyConfig(ctx));
  const samples = await Promise.all(topology.masters.map(async (node) => {
    const client = await access.connection(node, target.database);
    return { node, client, started: performance.now(), info: selectedInfo(await client.info()) };
  }));
  if (samples.length) await sleep(seconds * 1_000);
  return {
    pressure_windows: await Promise.all(samples.map(async (sample) => {
      const current = selectedInfo(await sample.client.info());
      return {
        node: sample.node,
        window: `${seconds}s` as "1s" | "10s",
        observation_seconds: Math.round((performance.now() - sample.started) / 10) / 100,
        evicted_keys_delta: Math.max(0, counter(current.evicted_keys) - counter(sample.info.evicted_keys)),
        oom_errors_delta: Math.max(0, counter(current.errorstat_OOM) - counter(sample.info.errorstat_OOM)),
      };
    })),
  };
}
