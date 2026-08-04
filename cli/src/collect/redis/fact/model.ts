import type { Fact } from "../../protocol";

export interface RedisFactTarget {
  endpoints: Array<[host: string, port: number]>;
  database: number;
  username?: string;
  useSsl: boolean;
  clusterType: "single" | "sentinel" | "cluster";
  endpointSource: "flag" | "profile" | "service-env" | "default";
  credentialSource: "url" | "profile" | "service-env" | "none";
}

export type RedisExecutionFact = Fact<{
  namespace: string;
  pod: string;
  container?: string;
  client: "@redis/client";
}>;

export type RedisTargetFact = Fact<{
  endpoint: string;
  endpointSource: RedisFactTarget["endpointSource"];
  username: string;
  credentialSource: RedisFactTarget["credentialSource"];
  configuredClusterType: RedisFactTarget["clusterType"];
  ssl: boolean;
}>;

export type RedisCapabilitiesFact = Fact<{
  redisClient: "@redis/client";
  reachable: true;
}>;

export type RedisEnvironmentFact = Fact<{
  variables: Record<string, string>;
}>;

export interface RedisInspectionFacts {
  execution: RedisExecutionFact;
  target: RedisTargetFact;
  environment: RedisEnvironmentFact;
  capabilities: RedisCapabilitiesFact;
}

function displayHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function buildRedisExecutionFact(
  execution: { namespace: string; pod: string; container?: string },
): RedisExecutionFact {
  return { status: "collected", ...execution, client: "@redis/client" };
}

export function buildRedisTargetFact(target: RedisFactTarget): RedisTargetFact {
  const scheme = target.useSsl ? "rediss" : "redis";
  return {
    status: "collected",
    endpoint: `${scheme}://${target.endpoints.map(([host, port]) => `${displayHost(host)}:${port}`).join(",")}/${target.database}`,
    endpointSource: target.endpointSource,
    username: target.username || "(Redis default user)",
    credentialSource: target.credentialSource,
    configuredClusterType: target.clusterType,
    ssl: target.useSsl,
  };
}

export function buildRedisEnvironmentFact(variables: Record<string, string>): RedisEnvironmentFact {
  return { status: "collected", variables };
}

export function buildRedisCapabilitiesFact(
  capability: {
    available: boolean;
    reason?: string;
    failureStatus?: "unavailable" | "failed";
  },
): RedisCapabilitiesFact {
  return capability.available
    ? {
        status: "collected",
        redisClient: "@redis/client",
        reachable: true,
      }
    : {
        status: capability.failureStatus ?? "unavailable",
        reason: capability.reason ?? "Redis endpoint 不可访问",
      };
}

/** Inspect Facts 可进入 manifest，不能携带连接密码、sentinel 密码或原始 DSN。 */
export function buildRedisInspectionFacts(
  target: RedisFactTarget,
  execution: { namespace: string; pod: string; container?: string },
  capability: {
    available: boolean;
    reason?: string;
    failureStatus?: "unavailable" | "failed";
  },
  environment: Record<string, string> = {},
): RedisInspectionFacts {
  return {
    execution: buildRedisExecutionFact(execution),
    target: buildRedisTargetFact(target),
    environment: buildRedisEnvironmentFact(environment),
    capabilities: buildRedisCapabilitiesFact(capability),
  };
}
