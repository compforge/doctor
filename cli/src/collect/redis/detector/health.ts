import {
  redisMasters,
  redisMemoryCapacity,
  redisPressureWindows,
  redisScans,
  type RedisEvidence,
} from "../model";
import type { RedisFinding } from "../findings";
import { keyspaceEvidence, nodeEvidence, pressureEvidence, type RedisDetector } from "./types";

export const detectStreamsWithoutTtl: RedisDetector = (
  e: RedisEvidence,
): RedisFinding[] => {
  const scans = redisScans(e);
  const databases = new Map<number, { count: number; scans: typeof scans }>();
  for (const scan of scans) {
    const count = scan.types
      .filter((row) => row.name === "stream")
      .reduce((total, row) => total + row.no_ttl_count, 0);
    const group = databases.get(scan.database) ?? { count: 0, scans: [] };
    group.count += count;
    group.scans.push(scan);
    databases.set(scan.database, group);
  }
  return [...databases.entries()].flatMap(([database, group]) =>
    group.count > 0 ? [{
      id: `redis.streams-without-ttl:db${database}`,
      kind: "redis.streams-without-ttl",
      severity: "warning",
      confidence: "medium",
      evidence: group.scans.map((scan) => keyspaceEvidence(scan.node.host, scan.node.port, database)),
      database,
      count: group.count,
    }] : []
  );
};

export const detectNodeHealth: RedisDetector = (e: RedisEvidence): RedisFinding[] => {
  const findings: RedisFinding[] = [];
  for (const node of redisMasters(e)) {
    const pressureWindows = redisPressureWindows(e, node);
    const pressure = pressureWindows.at(-1);
    const evidence = [
      nodeEvidence(node.host, node.port),
      ...pressureWindows.map((window) => pressureEvidence(window.window, node.host, node.port)),
    ];
    const fragmentation = Number(node.info?.mem_fragmentation_ratio ?? 0);
    if (fragmentation >= 1.5) {
      findings.push({
        id: `redis.memory-fragmentation:${node.host}:${node.port}`,
        kind: "redis.memory-fragmentation",
        severity: "info",
        confidence: "high",
        evidence,
        node: { host: node.host, port: node.port },
        ratio: fragmentation,
      });
    }
    const capacity = redisMemoryCapacity(node);
    const evictedKeysDelta = pressure?.evictedKeysDelta ?? 0;
    const oomErrorsDelta = pressure?.oomErrorsDelta ?? 0;
    const observationSeconds = pressure?.observationSeconds ?? 0;
    const evictedKeys = Number(node.info?.evicted_keys ?? 0);
    const oomErrors = redisCounter(node.info?.errorstat_OOM);
    if (capacity && (capacity.utilization >= 0.9 || evictedKeysDelta > 0 || oomErrorsDelta > 0)) {
      const exhausted = capacity.utilization >= 0.99
        || evictedKeysDelta > 0
        || oomErrorsDelta > 0
        || (capacity.utilization >= 0.9 && oomErrors > 0);
      findings.push({
        id: `redis.memory-capacity-${exhausted ? "exhausted" : "high"}:${node.host}:${node.port}`,
        kind: exhausted ? "redis.memory-capacity-exhausted" : "redis.memory-capacity-high",
        severity: exhausted ? "critical" : "warning",
        confidence: "high",
        evidence,
        node: { host: node.host, port: node.port },
        ...capacity,
        policy: String(node.info?.maxmemory_policy ?? "unknown"),
        observationSeconds,
        evictedKeysDelta,
        oomErrorsDelta,
        evictedKeys,
        oomErrors,
      });
    }
    if (oomErrors > 0) {
      findings.push({
        id: `redis.oom-errors-observed:${node.host}:${node.port}`,
        kind: "redis.oom-errors-observed",
        severity: "critical",
        confidence: "high",
        evidence,
        node: { host: node.host, port: node.port },
        count: oomErrors,
      });
    }
    if (evictedKeys > 0) {
      findings.push({
        id: `redis.evictions-observed:${node.host}:${node.port}`,
        kind: "redis.evictions-observed",
        severity: "warning",
        confidence: "high",
        evidence,
        node: { host: node.host, port: node.port },
        count: evictedKeys,
      });
    }
  }
  return findings;
};

function redisCounter(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const match = value.match(/(?:^|,)count=(\d+)/);
    return match ? Number(match[1]) : 0;
  }
  if (value && typeof value === "object" && "count" in value) {
    const count = Number((value as { count: unknown }).count);
    return Number.isFinite(count) ? count : 0;
  }
  return 0;
}
