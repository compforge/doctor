import {
  PROBE_RUNNABLE,
  probeUnavailable,
  probeUnnecessary,
  type Probe,
} from "../../protocol";
import type { RedisCollectContext } from "../context";
import type { RedisConfig } from "../config";
import type { RedisInspectionFacts } from "../fact/model";
import { redisMasterMemorySkew, redisMemoryCapacity } from "../model";
import type {
  RedisKeyspaceObservation,
  RedisNode,
  RedisNodeObservation,
  RedisObservation,
  RedisOverviewObservation,
  RedisPressureObservation,
  RedisScan,
  RedisKeyStatsObservation,
  RedisSlotRange,
} from "../model";
import { collectRedisMasterKeyStats, collectRedisPressure, collectRedisRuntime } from "./collector";

/** TS Redis collector 的原始结构化输出；进入 Evidence 前再拆成领域 Observations。 */
export interface RedisRuntimeProbeOutput {
  cluster_type: "single" | "sentinel" | "cluster";
  selected_database: number;
  masters: RedisNode[];
  replicas: RedisNode[];
  slot_ranges: RedisSlotRange[];
  scan_mode: "quick" | "sample";
  scans: RedisScan[];
  error?: string;
}

export interface RedisPressureProbeOutput {
  pressure_windows: Array<{
    node: { host: string; port: number };
    window: "1s" | "10s";
    observation_seconds: number;
    evicted_keys_delta: number;
    oom_errors_delta: number;
  }>;
}

export function redisObservationsFromRuntimeOutput(output: RedisRuntimeProbeOutput): RedisObservation[] {
  return [
    {
      id: "overview",
      kind: "overview",
      clusterType: output.cluster_type,
      scanMode: output.scan_mode,
      selectedDatabase: output.selected_database,
      slotRanges: output.slot_ranges,
    },
    ...output.masters.map((node): RedisNodeObservation => ({
      id: `node:${node.host}:${node.port}`,
      kind: "node",
      node,
    })),
    ...output.replicas.map((node): RedisNodeObservation => ({
      id: `node:${node.host}:${node.port}`,
      kind: "node",
      node,
    })),
    ...output.scans.map((scan): RedisKeyspaceObservation => ({
      id: `keyspace:${scan.node.host}:${scan.node.port}:db${scan.database}`,
      kind: "keyspace",
      scan,
    })),
  ];
}

function redisObservationsFromPressureOutput(output: RedisPressureProbeOutput): RedisPressureObservation[] {
  return output.pressure_windows.map((window) => ({
    id: `pressure:${window.window}:${window.node.host}:${window.node.port}`,
    kind: "pressure",
    node: window.node,
    window: window.window,
    observationSeconds: window.observation_seconds,
    evictedKeysDelta: window.evicted_keys_delta,
    oomErrorsDelta: window.oom_errors_delta,
  }));
}

function evaluateRedisRuntime(facts: RedisInspectionFacts) {
  if (facts.execution.status !== "collected") {
    return probeUnavailable(facts.execution.reason);
  }
  if (facts.target.status !== "collected") {
    return probeUnavailable(facts.target.reason);
  }
  if (facts.capabilities.status !== "collected") {
    return probeUnavailable(facts.capabilities.reason);
  }
  return PROBE_RUNNABLE;
}

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

function needsTenSecondPressureObservation(
  progress: Parameters<Probe<RedisObservation, RedisInspectionFacts, RedisConfig, RedisCollectContext>["evaluate"]>[2],
): boolean {
  const observations = progress.flatMap((result) => result.observations);
  const nodes = observations
    .filter((item): item is RedisNodeObservation => item.kind === "node")
    .map((item) => item.node)
    .filter((node) => node.role === "master");
  const oneSecond = observations.filter(
    (item): item is RedisPressureObservation => item.kind === "pressure" && item.window === "1s",
  );
  return nodes.some((node) => {
    const capacity = redisMemoryCapacity(node);
    return (capacity?.utilization ?? 0) >= 0.9
      || redisCounter(node.info?.errorstat_OOM) > 0
      || Number(node.info?.current_eviction_exceeded_time ?? 0) > 0;
  }) || oneSecond.some((window) => window.evictedKeysDelta > 0 || window.oomErrorsDelta > 0);
}

/** 一次受预算约束的只读访问，同时采集拓扑、节点状态和 keyspace 样本。 */
export function makeRedisRuntimeProbe(): Probe<
  RedisObservation,
  RedisInspectionFacts,
  RedisConfig,
  RedisCollectContext
> {
  return {
    id: "redis-probe",
    evaluate: evaluateRedisRuntime,
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill("redis-probe", { status: "unavailable", reason });
    },
    run: async (ctx, _facts, config) => {
      ctx.log("[collect] 运行 Redis 只读诊断探针…");
      try {
        const output = await collectRedisRuntime(ctx, config.scan);
        ctx.bundle.fill("redis-probe", {
          status: "ok",
          output: `${JSON.stringify(output, null, 2)}\n`,
          ext: "json",
        });
        return redisObservationsFromRuntimeOutput(output);
      } catch (err) {
        ctx.bundle.fill("redis-probe", {
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

function keyStatsTargets(
  progress: Parameters<Probe<RedisObservation, RedisInspectionFacts, RedisConfig, RedisCollectContext>["evaluate"]>[2],
  forced: boolean,
): Array<{ node: RedisNode; trigger: "forced" | "memory-skew"; memoryRatio?: number; masterCount: number }> {
  const observations = progress.flatMap((result) => result.observations);
  const overview = observations.find(
    (item): item is RedisOverviewObservation => item.kind === "overview",
  );
  if (!overview) return [];
  const masters = observations
    .filter((item): item is RedisNodeObservation => item.kind === "node")
    .map((item) => item.node)
    .filter((node) => node.role === "master");
  if (forced) {
    return masters.map((node) => ({ node, trigger: "forced", masterCount: masters.length }));
  }
  if (overview.clusterType !== "cluster" || overview.scanMode !== "sample") return [];
  const skew = redisMasterMemorySkew(masters);
  return skew ? [{ node: skew.target, trigger: "memory-skew", memoryRatio: skew.memoryRatio, masterCount: masters.length }] : [];
}

export function makeRedisKeyStatsProbe(): Probe<
  RedisObservation,
  RedisInspectionFacts,
  RedisConfig,
  RedisCollectContext
> {
  const id = "redis-key-stats";
  return {
    id,
    dependsOn: ["redis-probe"],
    evaluate: (facts, config, progress) => {
      const runtime = evaluateRedisRuntime(facts);
      if (!runtime.runnable) return runtime;
      return keyStatsTargets(progress, config.scan?.keyStats ?? false).length > 0
        ? PROBE_RUNNABLE
        : probeUnnecessary("仅 Cluster sample 模式且 master 数据集内存倾斜达到 1.5x 时执行");
    },
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill(id, { status: "unavailable", reason });
    },
    onUnnecessary: (ctx, reason) => {
      ctx.bundle.fill(id, { status: "unnecessary", reason });
    },
    run: async (ctx, _facts, config, progress) => {
      const targets = keyStatsTargets(progress, config.scan?.keyStats ?? false);
      if (!targets.length) throw new Error("Redis keyStats Probe 缺少可用的 master");
      try {
        const observations: RedisKeyStatsObservation[] = [];
        for (const target of targets) {
          const node = { host: target.node.host, port: target.node.port };
          ctx.log(`[collect] 对 master ${node.host}:${node.port} 运行 keyStats…`);
          const scan = await collectRedisMasterKeyStats(ctx, node, config.scan, target.masterCount);
          observations.push({
            id: `key-stats:${node.host}:${node.port}:db${scan.database}`,
            kind: "key-stats",
            trigger: target.trigger,
            memoryRatio: target.memoryRatio,
            scan,
          });
        }
        ctx.bundle.fill(id, {
          status: "ok",
          output: `${JSON.stringify({ scans: observations }, null, 2)}\n`,
          ext: "json",
        });
        return observations;
      } catch (err) {
        ctx.bundle.fill(id, {
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

export function makeRedisPressureProbe(seconds: 1 | 10): Probe<
  RedisObservation,
  RedisInspectionFacts,
  RedisConfig,
  RedisCollectContext
> {
  const window = `${seconds}s` as "1s" | "10s";
  const id = `redis-pressure-${window}`;
  return {
    id,
    dependsOn: seconds === 1 ? ["redis-probe"] : ["redis-probe", "redis-pressure-1s"],
    evaluate: (facts, _config, progress) => {
      const runtime = evaluateRedisRuntime(facts);
      if (!runtime.runnable || seconds === 1) return runtime;
      return needsTenSecondPressureObservation(progress)
        ? PROBE_RUNNABLE
        : probeUnnecessary("容量低于 90%，且 1 秒窗口未发现 eviction / OOM 拒写");
    },
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill(id, { status: "unavailable", reason });
    },
    onUnnecessary: (ctx, reason) => {
      ctx.bundle.fill(id, { status: "unnecessary", reason });
    },
    run: async (ctx) => {
      ctx.log(`[collect] 采集 Redis ${seconds} 秒容量压力窗口…`);
      try {
        const output = await collectRedisPressure(ctx, seconds);
        ctx.bundle.fill(id, {
          status: "ok",
          output: `${JSON.stringify(output, null, 2)}\n`,
          ext: "json",
        });
        return redisObservationsFromPressureOutput(output);
      } catch (err) {
        ctx.bundle.fill(id, {
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
