import type { Inspect } from "../../inspection";
import type { RedisCommandContext } from "../context";
import type { RedisConfig } from "../config";
import type { ConfirmedRedisTarget } from "../preparation";
import {
  buildRedisCapabilitiesFact,
  buildRedisExecutionFact,
  type RedisInspectionFacts,
} from "./model";

export type RedisSanitizedTarget = {
  namespace: string;
  pod: string;
  container?: string;
  endpoint: string;
  endpoint_source: string;
  username: string;
  credential_source: string;
  cluster_type: string;
  fact_status: RedisInspectionFacts["target"]["status"];
  reason?: string;
};

export function sanitizeRedisTarget(
  config: RedisConfig,
  target: RedisInspectionFacts["target"],
): RedisSanitizedTarget {
  if (target.status !== "collected") {
    return {
      namespace: config.collect.kubernetes.namespace,
      pod: config.target.pod,
      container: config.target.container,
      endpoint: "(unresolved)",
      endpoint_source: "unavailable",
      username: "(unknown)",
      credential_source: "unavailable",
      cluster_type: "unknown",
      fact_status: target.status,
      reason: target.reason,
    };
  }
  return {
    namespace: config.collect.kubernetes.namespace,
    pod: config.target.pod,
    container: config.target.container,
    endpoint: target.endpoint,
    endpoint_source: target.endpointSource,
    username: target.username,
    credential_source: target.credentialSource,
    cluster_type: target.configuredClusterType,
    fact_status: target.status,
  };
}

export function makeRedisInspect(
  confirmed: ConfirmedRedisTarget,
): Inspect<RedisInspectionFacts, RedisCommandContext> {
  return {
    id: "redis-target",
    run: async (ctx) => {
      const { config } = ctx;
      const execution = buildRedisExecutionFact({
        namespace: config.collect.kubernetes.namespace,
        pod: config.target.pod,
        container: config.target.container,
      });
      let available = false;
      let reason = confirmed.reason ?? "Redis 采集准备未完成";
      if (confirmed.target && ctx.redisAccess) {
        const endpoints = confirmed.target.clusterType === "sentinel" && confirmed.target.sentinelHosts.length
          ? confirmed.target.sentinelHosts
          : confirmed.target.endpoints;
        try {
          const [host, port] = endpoints[0]!;
          const credentials = confirmed.target.clusterType === "sentinel"
            ? {
                username: confirmed.target.sentinelUsername,
                password: confirmed.target.sentinelPassword,
              }
            : undefined;
          await (await ctx.redisAccess.connection({ host, port }, 0, credentials)).ping();
          available = true;
        } catch (err) {
          reason = `Redis 连通性检查失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const capabilities = buildRedisCapabilitiesFact({
        available,
        reason,
        failureStatus: "unavailable",
      });
      ctx.bundle.fill("capability", {
        status: available ? "ok" : "unavailable",
        reason: available ? undefined : reason,
      });
      return {
        execution,
        target: confirmed.targetFact,
        environment: confirmed.environmentFact,
        capabilities,
      };
    },
  };
}
