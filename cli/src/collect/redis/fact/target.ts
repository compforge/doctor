import { isIP } from "node:net";
import type { RedisProfileConfig } from "../../../app/config/model";
import type { ServiceRedisStoreCapability } from "@compforge/doctor-plugin";

/** 本轮 Redis 连接目标；包含凭据，只能停留在 Inspect / Probe 执行链内。 */
export interface RedisTarget {
  endpoints: Array<[host: string, port: number]>;
  database: number;
  username?: string;
  password?: string;
  useSsl: boolean;
  clusterType: "single" | "sentinel" | "cluster";
  timeout: number;
  sentinelHosts: Array<[string, number]>;
  sentinelMasterName: string;
  sentinelUsername?: string;
  sentinelPassword?: string;
  endpointSource: "flag" | "profile" | "service-env" | "default";
  credentialSource: "url" | "profile" | "service-env" | "none";
}

const REDIS_ENV_SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|AUTH|URL|URI|DSN)/i;

function parseEnv(raw: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) env.set(line.slice(0, index), line.slice(index + 1));
  }
  return env;
}

const REDIS_CANONICAL_ENV = {
  address: "REDIS_HOST",
  port: "REDIS_PORT",
  database: "REDIS_DB",
  username: "REDIS_USERNAME",
  password: "REDIS_PASSWORD",
  useSsl: "REDIS_USE_SSL",
  clusterType: "REDIS_CLUSTER_TYPE",
  sentinels: "REDIS_SENTINELS",
  sentinelMasterName: "REDIS_SENTINEL_MASTER_NAME",
  sentinelUsername: "REDIS_SENTINEL_USERNAME",
  sentinelPassword: "REDIS_SENTINEL_PASSWORD",
  timeout: "REDIS_TIMEOUT",
} as const;

export function projectRedisStoreEnvironment(
  raw: string,
  capability: ServiceRedisStoreCapability,
): string {
  const source = parseEnv(raw);
  const projected = new Map<string, string>();
  for (const [field, canonicalName] of Object.entries(REDIS_CANONICAL_ENV)) {
    const sourceName = capability.environment[field as keyof ServiceRedisStoreCapability["environment"]];
    const value = sourceName ? source.get(sourceName)?.trim() : undefined;
    if (value) projected.set(canonicalName, value);
  }
  if (!capability.environment.sentinels && projected.get("REDIS_HOST")) {
    projected.set("REDIS_SENTINELS", projected.get("REDIS_HOST")!);
  }
  return [...projected].map(([name, value]) => `${name}=${value}`).join("\n");
}

export function hasRedisStoreConfiguration(
  raw: string,
  capability: ServiceRedisStoreCapability,
): boolean {
  return !!parseEnv(raw).get(capability.environment.address)?.trim();
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parsePositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePort(value: string | undefined, fallback: number, source: string): number {
  if (!value?.trim()) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} 不是有效端口：${value}`);
  }
  return port;
}

function parseNonNegative(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseEndpoint(raw: string, defaultPort: number, source: string): [string, number] {
  const value = raw.trim();
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket <= 1) throw new Error(`${source} 地址无效：${raw}`);
    const host = value.slice(1, closingBracket);
    const suffix = value.slice(closingBracket + 1);
    if (!suffix) return [host, defaultPort];
    if (!suffix.startsWith(":")) throw new Error(`${source} 地址无效：${raw}`);
    const ports = suffix.slice(1).split(":");
    if (ports.length === 1) return [host, parsePort(ports[0], defaultPort, source)];
    if (ports.length === 2 && ports[0] === ports[1]) {
      return [host, parsePort(ports[0], defaultPort, source)];
    }
    throw new Error(`${source} 地址无效：${raw}`);
  }

  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon < 0) {
    return [value, defaultPort];
  }
  if (firstColon !== lastColon) {
    const duplicatedPort = value.match(/^([^:]+):(\d+):\2$/);
    if (duplicatedPort) {
      return [duplicatedPort[1]!, parsePort(duplicatedPort[2], defaultPort, source)];
    }
    // 未加方括号的 IPv6 只能使用全局端口；其它多冒号形态无法安全判定，直接拒绝。
    if (isIP(value) === 6) return [value, defaultPort];
    throw new Error(`${source} 地址无效：${raw}`);
  }
  const host = value.slice(0, firstColon);
  if (!host) throw new Error(`${source} 地址无效：${raw}`);
  return [host, parsePort(value.slice(firstColon + 1), defaultPort, source)];
}

function parseEndpoints(raw: string | undefined, defaultPort: number, source: string): Array<[string, number]> {
  if (!raw) return [];
  const endpoints = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseEndpoint(item, defaultPort, source));
  if (endpoints.length === 0) throw new Error(`${source} 未包含有效地址`);
  return endpoints;
}

function normalizeClusterType(value: string | undefined): RedisTarget["clusterType"] {
  return value === "sentinel" || value === "cluster" ? value : "single";
}

/** Redis Inspect 的环境事实只保留 Redis 相关变量；可能携带连接凭据的值整体脱敏。 */
export function extractRedisEnvironment(rawEnv: string): Record<string, string> {
  return Object.fromEntries(
    [...parseEnv(rawEnv).entries()]
      .filter(([name]) => name.toUpperCase().includes("REDIS"))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        REDIS_ENV_SECRET_NAME.test(name) || /^rediss?:\/\/[^/\s]*@/i.test(value)
          ? "[REDACTED]"
          : value,
      ]),
  );
}

/**
 * 服务运行时 env 是动态事实，profile 身份只作兜底；flag/profile URL 可显式覆盖地址。
 * URL 未携带身份时仍按来源层级补齐身份。
 */
export function resolveRedisTarget(
  rawEnv: string,
  profile: RedisProfileConfig | undefined,
  flagUrl?: string,
  databaseOverride?: number,
  capability?: ServiceRedisStoreCapability,
): RedisTarget {
  const env = parseEnv(capability ? projectRedisStoreEnvironment(rawEnv, capability) : rawEnv);
  const selectedUrl = flagUrl?.trim() || profile?.url?.trim();
  const endpointSource: RedisTarget["endpointSource"] = flagUrl?.trim()
    ? "flag"
    : profile?.url?.trim()
      ? "profile"
      : env.get("REDIS_HOST")
        ? "service-env"
        : "default";

  let endpoints: Array<[string, number]>;
  let database = parseNonNegative(env.get("REDIS_DB"), 0);
  let useSsl = parseBoolean(env.get("REDIS_USE_SSL"));
  let username: string | undefined;
  let password: string | undefined;
  let credentialSource: RedisTarget["credentialSource"] = "none";

  if (selectedUrl) {
    let parsed: URL;
    try {
      parsed = new URL(selectedUrl);
    } catch {
      throw new Error("Redis URL 格式无效");
    }
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("Redis URL 只支持 redis:// 或 rediss://");
    }
    if (!parsed.hostname) throw new Error("Redis URL 缺少 host");
    endpoints = [parseEndpoint(parsed.host, 6379, "Redis URL")];
    const pathDb = parsed.pathname.replace(/^\//, "");
    database = pathDb ? parseNonNegative(pathDb, 0) : 0;
    useSsl = parsed.protocol === "rediss:";
    if (parsed.password) {
      username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
      password = decodeURIComponent(parsed.password);
      credentialSource = "url";
    } else if (profile?.password) {
      username = profile.username;
      password = profile.password;
      credentialSource = "profile";
    } else if (env.get("REDIS_PASSWORD")) {
      username = env.get("REDIS_USERNAME") || undefined;
      password = env.get("REDIS_PASSWORD");
      credentialSource = "service-env";
    }
  } else {
    const defaultPort = parsePort(env.get("REDIS_PORT"), 6379, "REDIS_PORT");
    endpoints = parseEndpoints(env.get("REDIS_HOST") || "localhost", defaultPort, "REDIS_HOST");
    if (env.get("REDIS_PASSWORD")) {
      username = env.get("REDIS_USERNAME") || undefined;
      password = env.get("REDIS_PASSWORD");
      credentialSource = "service-env";
    } else if (profile?.password) {
      username = profile.username;
      password = profile.password;
      credentialSource = "profile";
    }
  }

  const clusterType = normalizeClusterType(profile?.cluster_type ?? env.get("REDIS_CLUSTER_TYPE"));
  if (databaseOverride !== undefined) database = databaseOverride;
  if (clusterType === "cluster" && database !== 0) {
    throw new Error(`Redis Cluster 只支持 database 0，当前为 ${database}`);
  }
  const sentinelHosts = clusterType === "sentinel"
    ? parseEndpoints(env.get("REDIS_SENTINELS"), 26379, "REDIS_SENTINELS")
    : [];

  return {
    endpoints,
    database,
    username,
    password,
    useSsl,
    clusterType,
    timeout: parsePositive(env.get("REDIS_TIMEOUT"), 5),
    sentinelHosts,
    sentinelMasterName: env.get("REDIS_SENTINEL_MASTER_NAME") || "mymaster",
    sentinelUsername: env.get("REDIS_SENTINEL_USERNAME") || undefined,
    sentinelPassword: env.get("REDIS_SENTINEL_PASSWORD") || undefined,
    endpointSource,
    credentialSource,
  };
}
