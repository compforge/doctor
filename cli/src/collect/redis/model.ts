import type { Diagnosis, Evidence } from "../protocol";
import type { RedisInspectionFacts } from "./fact/model";
import type { RedisFinding, RedisDiagnosisGoal } from "./findings";

export interface RedisNode {
  host: string;
  port: number;
  role: string;
  selected_database: number;
  databases: RedisDatabase[];
  dbsize?: number | null;
  info?: Record<string, unknown>;
  error?: string;
}

export interface RedisDatabase {
  database: number;
  keys: number;
  expires: number;
  average_ttl_ms: number;
}

export interface RedisGroup {
  name: string;
  count: number;
  memory_bytes: number;
  no_ttl_count: number;
  no_ttl_memory_bytes: number;
}

export interface RedisCountGroup {
  name: string;
  count: number;
}

export interface RedisKey {
  key: string;
  type: string;
  memory_bytes: number;
  ttl_ms: number;
  slot: number;
  length?: number | null;
}

export interface RedisScan {
  node: { host: string; port: number };
  database: number;
  scanned_keys: number;
  scan_complete: boolean;
  sampled_memory_bytes: number;
  average_sampled_bytes_per_key: number;
  types: RedisGroup[];
  prefixes: RedisGroup[];
  top_prefixes_by_key_count: RedisCountGroup[];
  ttl_buckets: Record<string, number>;
  top_slots: Array<{ slot: number; count: number; memory_bytes: number }>;
  top_keys: RedisKey[];
  top_streams: Array<RedisKey & { length: number | null }>;
}

export interface RedisSlotRange {
  start: number;
  end: number;
  master: { host: string; port: number };
  replicas: Array<{ host: string; port: number }>;
}

export interface RedisOverviewObservation {
  id: "overview";
  kind: "overview";
  clusterType: "single" | "sentinel" | "cluster";
  scanMode: "quick" | "sample";
  selectedDatabase: number;
  slotRanges: RedisSlotRange[];
  /** 基础拓扑/节点已取得，但 keyspace 等子采集未完整完成。 */
  partialReason?: string;
}

export interface RedisNodeObservation {
  id: string;
  kind: "node";
  node: RedisNode;
}

export interface RedisKeyspaceObservation {
  id: string;
  kind: "keyspace";
  scan: RedisScan;
}

export interface RedisPressureObservation {
  id: string;
  kind: "pressure";
  node: { host: string; port: number };
  window: "1s" | "10s";
  observationSeconds: number;
  evictedKeysDelta: number;
  oomErrorsDelta: number;
}

export interface RedisKeyStatsObservation {
  id: string;
  kind: "key-stats";
  trigger: "forced" | "memory-skew";
  memoryRatio?: number;
  scan: RedisScan;
}

export type RedisObservation =
  | RedisOverviewObservation
  | RedisNodeObservation
  | RedisKeyspaceObservation
  | RedisKeyStatsObservation
  | RedisPressureObservation;

/**
 * Redis detector 的领域证据：同一轮 probe 产生的结构化 observations，外加 Inspect
 * 取得的环境事实（目标身份、脱敏 endpoint、容器内 redis 客户端能力）——detector 靠它
 * 解释"这份证据为什么没拿到"，理由见 protocol.ts 的 Evidence 注释。
 */
export type RedisEvidence = Evidence<RedisObservation, RedisInspectionFacts>;

export type RedisDiagnosis = Diagnosis<RedisEvidence, RedisFinding, RedisDiagnosisGoal>;

export function buildRedisEvidence(
  observations: readonly RedisObservation[],
  facts: RedisInspectionFacts,
): RedisEvidence {
  return { observations, facts };
}

export function redisOverview(evidence: RedisEvidence): RedisOverviewObservation | undefined {
  return evidence.observations.find(
    (item): item is RedisOverviewObservation => item.kind === "overview",
  );
}

export function redisNodes(evidence: RedisEvidence): RedisNode[] {
  return evidence.observations
    .filter((item): item is RedisNodeObservation => item.kind === "node")
    .map((item) => item.node);
}

export function redisMasters(evidence: RedisEvidence): RedisNode[] {
  return redisNodes(evidence).filter((node) => node.role === "master");
}

export interface RedisMemoryCapacity {
  usedBytes: number;
  maxBytes: number;
  utilization: number;
}

export function redisMemoryCapacity(node: RedisNode): RedisMemoryCapacity | undefined {
  const usedBytes = Number(node.info?.used_memory ?? 0);
  const maxBytes = Number(node.info?.maxmemory ?? 0);
  const notCountedBytes = Number(node.info?.mem_not_counted_for_evict ?? 0);
  if (!Number.isFinite(usedBytes) || !Number.isFinite(maxBytes) || maxBytes <= 0) return undefined;
  const accountedUsedBytes = Math.max(0, usedBytes - (Number.isFinite(notCountedBytes) ? notCountedBytes : 0));
  return {
    usedBytes: accountedUsedBytes,
    maxBytes,
    utilization: accountedUsedBytes / maxBytes,
  };
}

export function redisScans(evidence: RedisEvidence): RedisScan[] {
  return evidence.observations
    .filter((item): item is RedisKeyspaceObservation => item.kind === "keyspace")
    .map((item) => item.scan);
}

export function redisKeyStats(evidence: RedisEvidence): RedisKeyStatsObservation[] {
  return evidence.observations.filter(
    (item): item is RedisKeyStatsObservation => item.kind === "key-stats",
  );
}

export interface RedisMasterMemorySkew {
  target: RedisNode;
  memoryRatio: number;
  targetMemoryBytes: number;
  peerMaxMemoryBytes: number;
}

export function redisMasterMemorySkew(masters: readonly RedisNode[]): RedisMasterMemorySkew | undefined {
  const measured = masters.flatMap((node) => {
    const memory = Number(node.info?.used_memory_dataset ?? node.info?.used_memory);
    return Number.isFinite(memory) && memory > 0 ? [{ node, memory }] : [];
  });
  if (measured.length < 2) return undefined;
  measured.sort((left, right) => right.memory - left.memory);
  const memoryRatio = measured[0]!.memory / measured.at(-1)!.memory;
  return memoryRatio >= 1.5
    ? {
        target: measured[0]!.node,
        memoryRatio,
        targetMemoryBytes: measured[0]!.memory,
        peerMaxMemoryBytes: measured[1]!.memory,
      }
    : undefined;
}

export function redisDatabases(
  evidence: RedisEvidence,
): Array<{ node: { host: string; port: number }; database: RedisDatabase }> {
  return redisMasters(evidence).flatMap((node) =>
    node.databases.map((database) => ({
      node: { host: node.host, port: node.port },
      database,
    }))
  );
}

export function redisNodeKeyCount(node: RedisNode): number | null {
  if (node.databases.length > 0) {
    return node.databases.reduce((total, database) => total + database.keys, 0);
  }
  return node.dbsize ?? null;
}

export function redisPressureWindows(
  evidence: RedisEvidence,
  node: { host: string; port: number },
): RedisPressureObservation[] {
  const windows = evidence.observations
    .filter((item): item is RedisPressureObservation =>
      item.kind === "pressure"
      && item.node.host === node.host
      && item.node.port === node.port
    )
    .sort((left, right) => left.observationSeconds - right.observationSeconds);
  if (windows.length) return windows;

  // 兼容自适应 Probe 拆分前已落盘的 Evidence Bundle。
  const legacy = redisMasters(evidence).find(
    (item) => item.host === node.host && item.port === node.port,
  );
  const seconds = Number(legacy?.info?.doctor_observation_seconds ?? 0);
  return seconds > 0 ? [{
    id: `pressure:1s:${node.host}:${node.port}`,
    kind: "pressure",
    node,
    window: "1s",
    observationSeconds: seconds,
    evictedKeysDelta: Number(legacy?.info?.doctor_evicted_keys_delta ?? 0),
    oomErrorsDelta: Number(legacy?.info?.doctor_oom_errors_delta ?? 0),
  }] : [];
}
