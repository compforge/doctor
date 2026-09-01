import { discoverRedisTopology } from "../../../infra/redis";
import type { Inspect } from "../../inspection";
import { selectRedisDatabaseScope } from "../config";
import {
  redisTopologyConfig,
  type RedisCommandContext,
} from "../context";
import {
  buildRedisDatabaseScopeFact,
  type RedisDatabaseScopeFact,
  type RedisInspectionFacts,
} from "./model";

function databasesFromInfo(info: Record<string, unknown>): number[] {
  return Object.entries(info)
    .filter(([name, value]) => /^db\d+$/.test(name) && !!value && typeof value === "object")
    .map(([name]) => Number(name.slice(2)))
    .sort((left, right) => left - right);
}

export async function discoverRedisDatabases(
  ctx: RedisCommandContext,
): Promise<{ clusterType: "single" | "sentinel" | "cluster"; databases: number[] }> {
  const access = ctx.redisAccess;
  const target = ctx.redisTarget;
  if (!access || !target) throw new Error("Redis 采集准备未完成");
  const topology = await discoverRedisTopology(access, redisTopologyConfig(ctx));
  if (topology.clusterType === "cluster") return { clusterType: "cluster", databases: [0] };
  const discovered = new Set<number>();
  for (const endpoint of topology.masters) {
    const info = await (await access.connection(endpoint, target.database)).info("keyspace");
    for (const database of databasesFromInfo(info)) discovered.add(database);
  }
  return {
    clusterType: topology.clusterType,
    databases: [...discovered].sort((left, right) => left - right),
  };
}

export interface RedisDatabaseScopeInspectOptions {
  selectScope?: typeof selectRedisDatabaseScope;
}

/**
 * @spec Redis database scope is resolved as a Fact after redis-target and before any Probe runs
 * @why Probe must consume the frozen resolved scope instead of hidden mutable CommandContext state
 */
export function makeRedisDatabaseScopeInspect(
  options: RedisDatabaseScopeInspectOptions = {},
): Inspect<RedisInspectionFacts, RedisCommandContext> {
  return {
    id: "redis-database-scope",
    dependsOn: ["redis-target"],
    run: async (ctx, facts) => {
      const prerequisite = facts.capabilities;
      if (!prerequisite || prerequisite.status !== "collected") {
        const databaseScope: RedisDatabaseScopeFact = {
          status: "unavailable",
          reason: prerequisite?.reason ?? "Redis target Inspect 未形成可用连接能力",
          cause: "prerequisite",
        };
        return { databaseScope };
      }

      const configuredClusterType = facts.target?.status === "collected"
        ? facts.target.configuredClusterType
        : "single";
      if (ctx.config.scan.mode === "quick") {
        const scope = ctx.config.requestedDatabase === undefined
          ? { mode: "all" as const, databases: [] }
          : { mode: "single" as const, databases: [ctx.config.requestedDatabase] };
        return {
          databaseScope: buildRedisDatabaseScopeFact({
            clusterType: configuredClusterType,
            clusterTypeSource: "configured",
            discoveredDatabases: [],
            scope,
          }),
        };
      }

      try {
        ctx.log("[collect] 正在发现 Redis database…");
        const discovered = await discoverRedisDatabases(ctx);
        const scope = await (options.selectScope ?? selectRedisDatabaseScope)(
          discovered.databases,
          discovered.clusterType,
          ctx.config.requestedDatabase,
        );
        if (!scope) {
          return {
            databaseScope: {
              status: "unavailable",
              reason: "用户取消 Redis database 范围选择",
              cause: "cancelled",
            },
          };
        }
        const databases = scope.databases.map((database) => `db${database}`).join("、") || "无数据 DB";
        ctx.log(`[collect] Redis database scope: ${scope.mode === "all" ? `所有有数据的 DB（${databases}）` : databases}`);
        return {
          databaseScope: buildRedisDatabaseScopeFact({
            clusterType: discovered.clusterType,
            clusterTypeSource: "runtime",
            discoveredDatabases: discovered.databases,
            scope,
          }),
        };
      } catch (error) {
        return {
          databaseScope: {
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}
