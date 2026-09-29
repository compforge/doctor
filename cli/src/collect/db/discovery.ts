import type { ServiceDatabaseDataSource, ServiceDatabaseTarget } from "@compforge/doctor-plugin";
import type { DatabaseQueryLimits, DatabaseQueryResult } from "@compforge/harness-toolbox/mysql";
import { clientKey } from "@compforge/harness-common";
import { CommandInputError } from "../../command";
import { chooseParameter } from "../../terminal/parameters";
import type { DbRequest } from "./input";

export interface DbProvider {
  id: string;
  /** Declaration references; these are not physical database or connection-pool identities. */
  dataSources: Pick<ServiceDatabaseDataSource, "id" | "description">[];
  target: ServiceDatabaseTarget;
  source: string;
  query(sql: string, values: readonly unknown[], limits: DatabaseQueryLimits, database?: string): Promise<DatabaseQueryResult>;
}
export interface DbTarget {
  host: string;
  port: number;
  database: string;
  providers: DbProvider[];
}
export interface DbCandidate extends DbTarget { table?: string }
export interface DbSelection {
  provider: DbProvider;
  dataSources: DbProvider["dataSources"];
  database: string;
  table?: string;
}

function targetKey(provider: DbProvider, database: string, table?: string): string {
  return JSON.stringify([provider.target.host, provider.target.port, database, table]);
}

/** Credentials participate only in internal access equivalence, never in exported resource identity. */
function accessKey(provider: DbProvider): string {
  const { host, port, user, password } = provider.target;
  return clientKey("db-access", { host, port, user, password });
}

/** Within this invocation's environment, several declarations may resolve to one configured database. */
export function databaseTargets(providers: readonly DbProvider[]): DbTarget[] {
  const targets = new Map<string, DbTarget>();
  for (const provider of providers) {
    const { host, port, database } = provider.target;
    const key = targetKey(provider, database);
    const existing = targets.get(key);
    if (existing) existing.providers.push(provider);
    else targets.set(key, { host, port, database, providers: [provider] });
  }
  return [...targets.values()];
}
export interface DbDiscovery {
  provider: DbProvider;
  result?: DatabaseQueryResult;
  error?: string;
}

/** Do not put driver messages in logs/evidence: they may echo SQL, credentials or row values. */
export function databaseFailure(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code)
    ? `数据库操作失败（${code}）` : "数据库操作失败或超时；请检查连接、权限与查询限制";
}

export async function discoverDatabases(request: DbRequest, providers: readonly DbProvider[]): Promise<DbDiscovery[]> {
  const results: DbDiscovery[] = [];
  for (const provider of providers) {
    try {
      const predicates: string[] = [];
      const values: string[] = [];
      if (request.database) { predicates.push("TABLE_SCHEMA = ?"); values.push(request.database); }
      if (request.table) { predicates.push("TABLE_NAME = ?"); values.push(request.table); }
      const databaseOnly = request.action === "databases" || (!request.table && request.action === "query");
      if (databaseOnly) { values.length = 0; if (request.database) values.push(request.database); }
      const sql = databaseOnly
        ? request.database ? "SELECT SCHEMA_NAME AS database_name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?" : "SHOW DATABASES"
        : `SELECT TABLE_SCHEMA AS database_name, TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.TABLES${predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""} ORDER BY TABLE_SCHEMA, TABLE_NAME`;
      results.push({ provider, result: await provider.query(sql, values, request.limits) });
    } catch (error) { results.push({ provider, error: databaseFailure(error) }); }
  }
  return results;
}

export function databaseCandidates(discovery: readonly DbDiscovery[], request: DbRequest): DbCandidate[] {
  const candidates = new Map<string, DbCandidate>();
  for (const { provider, result } of discovery) {
    for (const row of result?.rows ?? []) {
      const database = row.database_name ?? row.Database;
      if (typeof database !== "string" || (request.database && database !== request.database)) continue;
      const table = typeof row.table_name === "string" ? row.table_name : undefined;
      if (request.table && table !== request.table) continue;
      const key = targetKey(provider, database, table);
      const existing = candidates.get(key);
      if (existing) {
        if (!existing.providers.includes(provider)) existing.providers.push(provider);
      } else {
        candidates.set(key, { host: provider.target.host, port: provider.target.port, database, table, providers: [provider] });
      }
    }
  }
  return [...candidates.values()];
}

/** Incomplete discovery can never prove uniqueness; user SQL is executed on exactly one target. */
export async function selectDatabaseTarget(request: DbRequest, discovery: readonly DbDiscovery[]): Promise<DbSelection> {
  if (discovery.some(item => item.error || item.result?.truncated)) {
    throw new CommandInputError("数据库发现不完整，无法确定唯一目标；请先修复访问失败，或通过 --database / --table 缩小发现范围");
  }
  let candidates = databaseCandidates(discovery, request);
  if (!candidates.length) throw new CommandInputError("Service 可见范围内未找到指定 Database / Table");
  const databases = [...new Set(candidates.map(candidate => candidate.database))];
  if (databases.length > 1) {
    const database = await chooseParameter("--database", databases, request.interactive);
    candidates = candidates.filter(candidate => candidate.database === database);
  }
  const tables = [...new Set(candidates.map(candidate => candidate.table).filter((table): table is string => !!table))];
  if (tables.length > 1) {
    const table = await chooseParameter("--table", tables, request.interactive);
    candidates = candidates.filter(candidate => candidate.table === table);
  }
  if (candidates.length > 1) {
    const source = await chooseParameter("--data-source（同名数据库目标有歧义）",
      candidates.flatMap(candidate => candidate.providers.flatMap(provider => provider.dataSources.map(source => source.id))), request.interactive);
    candidates = candidates.filter(candidate => candidate.providers.some(provider => provider.dataSources.some(item => item.id === source)));
  }
  const candidate = candidates[0]!;
  const accesses = new Map<string, DbProvider[]>();
  for (const provider of candidate.providers) {
    const key = accessKey(provider);
    const aliases = accesses.get(key);
    if (aliases) aliases.push(provider);
    else accesses.set(key, [provider]);
  }
  let aliases = [...accesses.values()][0]!;
  if (accesses.size > 1) {
    const source = await chooseParameter("--data-source（同库存在不同连接身份）",
      candidate.providers.flatMap(provider => provider.dataSources.map(item => item.id)), request.interactive);
    aliases = [...accesses.values()].find(group => group.some(provider => provider.dataSources.some(item => item.id === source)))!;
  }
  return { provider: aliases[0]!, dataSources: aliases.flatMap(provider => provider.dataSources),
    database: candidate.database, table: candidate.table };
}
