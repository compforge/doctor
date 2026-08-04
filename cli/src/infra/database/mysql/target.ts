import type { DatabaseIdentity, DatabaseTarget } from "..";

export interface MysqlTarget extends DatabaseTarget {
  credentialSource: "service-env" | "profile";
}

export interface DatabaseEnvTargetOptions {
  label: string;
  prefix: string;
  fallback?: DatabaseIdentity;
  defaultPort?: number;
}

/** Parse a database endpoint and credentials from a service environment dump. */
export function parseMysqlEnvTarget(
  raw: string,
  options: DatabaseEnvTargetOptions,
): MysqlTarget {
  const env = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) env.set(line.slice(0, index), line.slice(index + 1));
  }

  const { label, prefix, fallback, defaultPort = 3306 } = options;
  const host = env.get(`${prefix}_HOST`);
  const database = env.get(`${prefix}_DATABASE`) || env.get(`${prefix}_NAME`);
  const port = Number(env.get(`${prefix}_PORT`) || String(defaultPort));
  if (!host || !database || !Number.isInteger(port) || port <= 0) {
    throw new Error(`${label} 未暴露有效的 ${prefix}_HOST/PORT/DATABASE`);
  }

  const envUser = env.get(`${prefix}_USERNAME`) || env.get(`${prefix}_USER`);
  const envPassword = env.get(`${prefix}_PASSWORD`);
  if (envUser && envPassword) {
    return {
      host,
      port,
      database,
      user: envUser,
      password: envPassword,
      credentialSource: "service-env",
    };
  }
  if (!fallback?.user || !fallback.password) {
    throw new Error(`${label} 未暴露完整的 ${prefix}_USERNAME/PASSWORD，且未配置 profile 数据库身份兜底`);
  }
  return { host, port, database, ...fallback, credentialSource: "profile" };
}
