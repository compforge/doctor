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

export interface RedisDatabaseScope {
  mode: "all" | "single";
  databases: number[];
}

export type RedisDatabaseScopeFact =
  | ({
      status: "collected";
      clusterType: RedisFactTarget["clusterType"];
      clusterTypeSource: "configured" | "runtime";
      discoveredDatabases: number[];
    } & RedisDatabaseScope)
  | { status: "unavailable"; reason: string; cause: "prerequisite" | "cancelled" }
  | { status: "failed"; reason: string };

export interface RedisInspectionFacts {
  execution: RedisExecutionFact;
  target: RedisTargetFact;
  environment: RedisEnvironmentFact;
  capabilities: RedisCapabilitiesFact;
  databaseScope: RedisDatabaseScopeFact;
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

export function buildRedisDatabaseScopeFact(input: {
  clusterType: RedisFactTarget["clusterType"];
  clusterTypeSource: "configured" | "runtime";
  discoveredDatabases: readonly number[];
  scope: RedisDatabaseScope;
}): RedisDatabaseScopeFact {
  return {
    status: "collected",
    clusterType: input.clusterType,
    clusterTypeSource: input.clusterTypeSource,
    discoveredDatabases: [...input.discoveredDatabases],
    mode: input.scope.mode,
    databases: [...input.scope.databases],
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
  databaseScope: RedisDatabaseScope = { mode: "single", databases: [target.database] },
): RedisInspectionFacts {
  return {
    execution: buildRedisExecutionFact(execution),
    target: buildRedisTargetFact(target),
    environment: buildRedisEnvironmentFact(environment),
    capabilities: buildRedisCapabilitiesFact(capability),
    databaseScope: buildRedisDatabaseScopeFact({
      clusterType: target.clusterType,
      clusterTypeSource: "configured",
      discoveredDatabases: [],
      scope: databaseScope,
    }),
  };
}
