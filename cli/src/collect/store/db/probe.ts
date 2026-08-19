import type { Probe } from "../../protocol";
import { PROBE_RUNNABLE, probeUnavailable } from "../../protocol";
import {
  collectMysqlCapacity,
  collectMysqlLoad,
  collectMysqlLockWaits,
  collectMysqlServerInfo,
} from "../mysql-diagnosis";
import type { StoreConfig } from "../config";
import type { DbCommandContext } from "./context";
import type { DbInspectionFacts } from "./fact/model";
import type { DbObservation, DbServerInfoObservation } from "./model";

type DbProbe = Probe<DbObservation, DbInspectionFacts, StoreConfig, DbCommandContext>;

function accessEvaluation(facts: DbInspectionFacts) {
  return facts.access.status === "collected"
    ? PROBE_RUNNABLE
    : probeUnavailable(facts.access.reason);
}

function unavailable(outcome: string) {
  return (ctx: DbCommandContext, reason: string) => ctx.bundle.fill(outcome, { status: "unavailable", reason });
}

function reason(prefix: string, error: unknown): string {
  return `${prefix}：${error instanceof Error ? error.message : String(error)}`;
}

const HEALTH_PROBE: DbProbe = {
  id: "health",
  evaluate: accessEvaluation,
  onUnavailable: unavailable("health"),
  run: async (ctx) => {
    try {
      const startedAt = Date.now();
      const initial = await ctx.database!.queryOne(ctx.target!, "SELECT 1 AS doctor_store_probe", []);
      const connectionAndQueryLatencyMs = Date.now() - startedAt;
      const reusedAt = Date.now();
      const reused = await ctx.database!.queryOne(ctx.target!, "SELECT 1 AS doctor_store_probe", []);
      const observation = {
        id: "db-health" as const,
        kind: "db-health" as const,
        queryable: Number(initial?.doctor_store_probe) === 1 && Number(reused?.doctor_store_probe) === 1,
        connectionAndQueryLatencyMs,
        queryLatencyMs: Date.now() - reusedAt,
      };
      ctx.bundle.fill("health", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("health", { status: "failed", reason: reason("DB 健康检查失败", error) });
      return [];
    }
  },
};

const SERVER_INFO_PROBE: DbProbe = {
  id: "server-info",
  evaluate: accessEvaluation,
  onUnavailable: unavailable("server-info"),
  run: async (ctx) => {
    try {
      const observation = {
        id: "db-server-info" as const,
        kind: "db-server-info" as const,
        ...await collectMysqlServerInfo(ctx.database!, ctx.target!),
      };
      ctx.bundle.fill("server-info", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("server-info", { status: "failed", reason: reason("读取 DB 服务信息失败", error) });
      return [];
    }
  },
};

const CAPACITY_PROBE: DbProbe = {
  id: "capacity",
  evaluate: accessEvaluation,
  onUnavailable: unavailable("capacity"),
  run: async (ctx) => {
    try {
      const observation = {
        id: "db-capacity" as const,
        kind: "db-capacity" as const,
        ...await collectMysqlCapacity(ctx.database!, ctx.target!),
      };
      ctx.bundle.fill("capacity", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("capacity", { status: "failed", reason: reason("读取 schema 容量失败", error) });
      return [];
    }
  },
};

const LOAD_PROBE: DbProbe = {
  id: "load",
  dependsOn: ["server-info"],
  evaluate: accessEvaluation,
  onUnavailable: unavailable("load"),
  run: async (ctx, _facts, _config, progress) => {
    const serverInfo = progress.flatMap((item) => item.observations)
      .find((item): item is DbServerInfoObservation => item.kind === "db-server-info");
    try {
      const observation = {
        id: "db-load" as const,
        kind: "db-load" as const,
        ...await collectMysqlLoad(ctx.database!, ctx.target!, serverInfo?.maxConnections ?? 0),
      };
      ctx.bundle.fill("load", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("load", { status: "failed", reason: reason("读取 DB 负载失败", error) });
      return [];
    }
  },
};

const LOCK_WAITS_PROBE: DbProbe = {
  id: "lock-waits",
  evaluate: accessEvaluation,
  onUnavailable: unavailable("lock-waits"),
  run: async (ctx) => {
    try {
      const observation = {
        id: "db-lock-waits" as const,
        kind: "db-lock-waits" as const,
        ...await collectMysqlLockWaits(ctx.database!, ctx.target!),
      };
      ctx.bundle.fill("lock-waits", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("lock-waits", {
        status: "unavailable",
        reason: reason("当前账号或版本无法读取 InnoDB 事务", error),
      });
      return [];
    }
  },
};

export function makeDbProbes(): DbProbe[] {
  return [HEALTH_PROBE, SERVER_INFO_PROBE, CAPACITY_PROBE, LOAD_PROBE, LOCK_WAITS_PROBE];
}
