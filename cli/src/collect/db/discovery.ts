import type { ServiceDatabaseTarget } from "@compforge/doctor-plugin";
import type { DatabaseQueryLimits, DatabaseQueryResult } from "@compforge/harness-toolbox/mysql";
import { CommandInputError } from "../../command";
import { chooseParameter } from "../../terminal/parameters";
import type { DbRequest } from "./input";

export interface DbProvider {
  id: string;
  target: ServiceDatabaseTarget;
  source: string;
  query(sql: string, values: readonly unknown[], limits: DatabaseQueryLimits, database?: string): Promise<DatabaseQueryResult>;
}
export interface DbCandidate { provider: DbProvider; database: string; table?: string }
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
  return discovery.flatMap(({ provider, result }) => (result?.rows ?? []).flatMap(row => {
    const database = row.database_name ?? row.Database;
    if (typeof database !== "string" || (request.database && database !== request.database)) return [];
    const table = typeof row.table_name === "string" ? row.table_name : undefined;
    if (request.table && table !== request.table) return [];
    return [{ provider, database, table }];
  }));
}

/** Incomplete discovery can never prove uniqueness; user SQL is executed on exactly one target. */
export async function selectDatabaseTarget(request: DbRequest, discovery: readonly DbDiscovery[]): Promise<DbCandidate> {
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
  if (candidates.length !== 1) throw new CommandInputError("同名 Database / Table 存在于多个访问目标，仍有歧义；请调整 Service 的目标声明，本次不会广播执行 SQL");
  return candidates[0]!;
}
