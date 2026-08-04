import type { FindingMeta } from "../protocol";

export type RedisDiagnosisGoal = "redis-memory-capacity" | "redis-memory-distribution";

export interface RedisNodeRef {
  host: string;
  port: number;
}

export type RedisFinding =
  | (FindingMeta<"redis.memory-skew-with-balanced-keys"> & {
      memoryRatio: number;
      keyRatio: number;
    })
  | (FindingMeta<"redis.memory-skew"> & { memoryRatio: number; keyRatio: number })
  | (FindingMeta<"redis.memory-skew-dominated-by-large-keys"> & {
      node: RedisNodeRef;
      database: number;
      keyCount: number;
      memoryBytes: number;
      datasetShare: number;
      skewExcessShare: number;
    })
  | (FindingMeta<"redis.sampled-key-size-skew"> & { database: number; ratio: number })
  | (FindingMeta<"redis.prefix-concentration"> & {
      node: RedisNodeRef;
      database: number;
      share: number;
      prefix: string;
    })
  | (FindingMeta<"redis.type-concentration"> & {
      node: RedisNodeRef;
      database: number;
      share: number;
      redisType: string;
    })
  | (FindingMeta<"redis.slot-concentration"> & {
      node: RedisNodeRef;
      database: number;
      share: number;
      slot: number;
    })
  | (FindingMeta<"redis.streams-without-ttl"> & { database: number; count: number })
  | (FindingMeta<"redis.memory-fragmentation"> & {
      node: RedisNodeRef;
      ratio: number;
    })
  | (FindingMeta<"redis.memory-capacity-high" | "redis.memory-capacity-exhausted"> & {
      node: RedisNodeRef;
      usedBytes: number;
      maxBytes: number;
      utilization: number;
      policy: string;
      observationSeconds: number;
      evictedKeysDelta: number;
      oomErrorsDelta: number;
      evictedKeys: number;
      oomErrors: number;
    })
  | (FindingMeta<"redis.oom-errors-observed"> & {
      node: RedisNodeRef;
      count: number;
    })
  | (FindingMeta<"redis.evictions-observed"> & {
      node: RedisNodeRef;
      count: number;
    });
