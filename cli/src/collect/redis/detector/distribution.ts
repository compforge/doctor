import {
  redisKeyStats,
  redisMasterMemorySkew,
  redisMasters,
  redisNodeKeyCount,
  redisOverview,
  redisScans,
  type RedisEvidence,
} from "../model";
import type { RedisFinding } from "../findings";
import { keyspaceEvidence, nodeEvidence, ratio, type RedisDetector } from "./types";

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "redis-distribution" },
};

const LARGE_KEY_LIMIT = 10;
const LARGE_KEY_DATASET_SHARE = 0.3;
const SKEW_EXCESS_EXPLAINED_SHARE = 0.8;

export const detectMasterSkew: RedisDetector = (e: RedisEvidence): RedisFinding[] => {
  const findings: RedisFinding[] = [];
  const masters = redisMasters(e);
  const scans = redisScans(e);
  const refs = masters.map((node) => nodeEvidence(node.host, node.port));
  const memoryRatio = redisMasterMemorySkew(masters)?.memoryRatio ?? ratio(
    masters.map((node) => node.info?.used_memory_dataset ?? node.info?.used_memory),
  );
  const keyRatio = ratio(masters.map(redisNodeKeyCount));
  if (memoryRatio >= 1.5) {
    findings.push(keyRatio <= 1.2
      ? {
          ...FINDING_META,
          id: "redis.memory-skew-with-balanced-keys",
          kind: "redis.memory-skew-with-balanced-keys",
          severity: "warning",
          confidence: "high",
          evidence: refs,
          memoryRatio,
          keyRatio,
        }
      : {
          ...FINDING_META,
          id: "redis.memory-skew",
          kind: "redis.memory-skew",
          severity: "warning",
          confidence: "high",
          evidence: refs,
          memoryRatio,
          keyRatio,
        });
  }
  const scansByDatabase = new Map<number, typeof scans>();
  for (const scan of scans) {
    const group = scansByDatabase.get(scan.database) ?? [];
    group.push(scan);
    scansByDatabase.set(scan.database, group);
  }
  for (const [database, group] of scansByDatabase) {
    const averageRatio = ratio(group.map((scan) => scan.average_sampled_bytes_per_key));
    if (averageRatio < 1.5) continue;
    findings.push({
      ...FINDING_META,
      id: `redis.sampled-key-size-skew:db${database}`,
      kind: "redis.sampled-key-size-skew",
      severity: "warning",
      confidence: "medium",
      evidence: group.map((scan) => keyspaceEvidence(scan.node.host, scan.node.port, scan.database)),
      database,
      ratio: averageRatio,
    });
  }
  return findings;
};

export const detectLargeKeysExplainingMasterSkew: RedisDetector = (e: RedisEvidence): RedisFinding[] => {
  if (redisOverview(e)?.clusterType !== "cluster") return [];

  const masters = redisMasters(e);
  const skew = redisMasterMemorySkew(masters);
  if (!skew) return [];

  const keyCounts = masters.flatMap((node) => {
    const count = redisNodeKeyCount(node);
    return count === null ? [] : [count];
  });
  if (keyCounts.length !== masters.length) return [];
  const minKeyCount = Math.min(...keyCounts);
  const maxKeyCount = Math.max(...keyCounts);
  const keyRatio = minKeyCount > 0 ? maxKeyCount / minKeyCount : maxKeyCount === 0 ? 1 : Infinity;
  if (keyRatio > 1.2) return [];

  const keyStats = redisKeyStats(e).find((item) =>
    item.scan.node.host === skew.target.host
    && item.scan.node.port === skew.target.port
    && item.scan.scan_complete
  );
  if (!keyStats) return [];

  // 用次大 master 作为基线，避免拿最小节点放大“大 key 已解释的额外内存”。
  const skewExcessBytes = skew.targetMemoryBytes - skew.peerMaxMemoryBytes;
  if (skewExcessBytes <= 0) return [];

  let memoryBytes = 0;
  const topKeys = keyStats.scan.top_keys.slice(0, LARGE_KEY_LIMIT);
  for (let index = 0; index < topKeys.length; index += 1) {
    memoryBytes += topKeys[index]!.memory_bytes;
    const datasetShare = memoryBytes / skew.targetMemoryBytes;
    const skewExcessShare = memoryBytes / skewExcessBytes;
    if (datasetShare < LARGE_KEY_DATASET_SHARE || skewExcessShare < SKEW_EXCESS_EXPLAINED_SHARE) continue;

    return [{
      ...FINDING_META,
      id: `redis.memory-skew-dominated-by-large-keys:${skew.target.host}:${skew.target.port}:db${keyStats.scan.database}`,
      kind: "redis.memory-skew-dominated-by-large-keys",
      severity: "warning",
      confidence: "high",
      evidence: [
        ...masters.map((node) => nodeEvidence(node.host, node.port)),
        { observationId: keyStats.id, role: "supporting" },
      ],
      node: { host: skew.target.host, port: skew.target.port },
      database: keyStats.scan.database,
      keyCount: index + 1,
      memoryBytes,
      datasetShare,
      skewExcessShare,
    }];
  }
  return [];
};

export const detectConcentrations: RedisDetector = (e: RedisEvidence): RedisFinding[] => {
  const findings: RedisFinding[] = [];
  for (const scan of redisScans(e)) {
    const sampledMemory = scan.sampled_memory_bytes || 0;
    if (!sampledMemory) continue;
    const evidence = [keyspaceEvidence(scan.node.host, scan.node.port, scan.database)];
    const prefix = scan.prefixes[0];
    if (prefix && prefix.memory_bytes / sampledMemory >= 0.5) {
      findings.push({
        ...FINDING_META,
        id: `redis.prefix-concentration:${scan.node.host}:${scan.node.port}:db${scan.database}`,
        kind: "redis.prefix-concentration",
        severity: "info",
        confidence: "medium",
        evidence,
        node: scan.node,
        database: scan.database,
        share: prefix.memory_bytes / sampledMemory,
        prefix: prefix.name,
      });
    }
    const type = scan.types[0];
    if (type && type.memory_bytes / sampledMemory >= 0.7) {
      findings.push({
        ...FINDING_META,
        id: `redis.type-concentration:${scan.node.host}:${scan.node.port}:db${scan.database}`,
        kind: "redis.type-concentration",
        severity: "info",
        confidence: "medium",
        evidence,
        node: scan.node,
        database: scan.database,
        share: type.memory_bytes / sampledMemory,
        redisType: type.name,
      });
    }
    const slot = scan.top_slots[0];
    if (slot && slot.memory_bytes / sampledMemory >= 0.2) {
      findings.push({
        ...FINDING_META,
        id: `redis.slot-concentration:${scan.node.host}:${scan.node.port}:db${scan.database}`,
        kind: "redis.slot-concentration",
        severity: "info",
        confidence: "medium",
        evidence,
        node: scan.node,
        database: scan.database,
        share: slot.memory_bytes / sampledMemory,
        slot: slot.slot,
      });
    }
  }
  return findings;
};
