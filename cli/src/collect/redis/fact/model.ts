import {
  collectedFact,
  type Fact,
} from "../../protocol";

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
}, "redis.execution">;

export type RedisTargetFact = Fact<{
  endpoint: string;
  endpointSource: RedisFactTarget["endpointSource"];
  username: string;
  credentialSource: RedisFactTarget["credentialSource"];
  configuredClusterType: RedisFactTarget["clusterType"];
  ssl: boolean;
}, "redis.target">;

export type RedisCapabilitiesFact = Fact<{
  redisClient: "@redis/client";
  reachable: true;
}, "redis.capabilities">;

export type RedisEnvironmentFact = Fact<{
  variables: Record<string, string>;
}, "redis.environment">;

export interface RedisDatabaseScope {
  mode: "all" | "single";
  databases: number[];
}

type RedisDatabaseScopeValue = {
  clusterType: RedisFactTarget["clusterType"];
  clusterTypeSource: "configured" | "runtime";
  discoveredDatabases: number[];
} & RedisDatabaseScope;

export type RedisDatabaseScopeFact =
  | Extract<Fact<RedisDatabaseScopeValue, "redis.database-scope">, { status: "collected" }>
  | (Extract<Fact<Record<string, never>, "redis.database-scope">, { status: "unavailable" }> & {
      cause: "prerequisite" | "cancelled";
    })
  | Extract<Fact<Record<string, never>, "redis.database-scope">, { status: "failed" }>;

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
  return collectedFact("redis.execution", "redis-target", {
    ...execution,
    client: "@redis/client" as const,
  });
}

export function buildRedisTargetFact(target: RedisFactTarget): RedisTargetFact {
  const scheme = target.useSsl ? "rediss" : "redis";
  return collectedFact("redis.target", "redis-target", {
    endpoint: `${scheme}://${target.endpoints.map(([host, port]) => `${displayHost(host)}:${port}`).join(",")}/${target.database}`,
    endpointSource: target.endpointSource,
    username: target.username || "(Redis default user)",
    credentialSource: target.credentialSource,
    configuredClusterType: target.clusterType,
    ssl: target.useSsl,
  });
}

export function buildRedisEnvironmentFact(variables: Record<string, string>): RedisEnvironmentFact {
  return collectedFact("redis.environment", "redis-target", { variables });
}

export function buildRedisCapabilitiesFact(
  capability: {
    available: boolean;
    reason?: string;
    failureStatus?: "unavailable" | "failed";
  },
): RedisCapabilitiesFact {
  return capability.available
    ? collectedFact("redis.capabilities", "redis-target", {
        redisClient: "@redis/client",
        reachable: true,
      })
    : {
        kind: "redis.capabilities",
        schemaVersion: 1,
        producer: { origin: "core", id: "redis-target" },
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
  return collectedFact("redis.database-scope", "redis-database-scope", {
    clusterType: input.clusterType,
    clusterTypeSource: input.clusterTypeSource,
    discoveredDatabases: [...input.discoveredDatabases],
    mode: input.scope.mode,
    databases: [...input.scope.databases],
  });
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
