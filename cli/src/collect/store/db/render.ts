import type { StoreConfig } from "../config";
import type { DbInspectionFacts } from "./fact/model";
import type { DbObservations } from "./model";

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function buildDbSummary(
  config: StoreConfig,
  facts: DbInspectionFacts,
  observations: DbObservations,
): string {
  const health = observations.health;
  const server = observations.serverInfo;
  const capacity = observations.capacity;
  const load = observations.load;
  const locks = observations.lockWaits;
  const database = facts.configuration.status === "collected" ? facts.configuration.database : "unknown";
  const topTables = capacity?.topTables.slice(0, 5)
    .map((table) => `\`${table.table}\` ${formatBytes(table.totalBytes)}`).join("；") || "未取得";
  const usage = load?.current.connectionUsagePercent;
  return [
    "# DB Store 诊断摘要",
    "",
    `- Service: \`${config.service}\``,
    `- Store: \`${config.capability.id}\``,
    `- Database: \`${database}\``,
    `- 健康: **${health ? (health.queryable ? "正常" : "异常") : "未取得"}**`,
    `- 首次连接+查询: ${health?.connectionAndQueryLatencyMs ?? "n/a"} ms；复用连接查询: ${health?.queryLatencyMs ?? "n/a"} ms`,
    `- MySQL: ${server ? `\`${server.version}\`，${server.readOnly ? "read-only" : "read-write"}` : "未取得"}`,
    `- Schema 逻辑容量: **${capacity ? formatBytes(capacity.totalBytes) : "未取得"}**（近似值）`,
    `- 空间最大的表: ${topTables}`,
    `- 连接: ${load ? `${load.current.connectedThreads} / ${load.current.maxConnections || "unknown"}${usage === undefined ? "" : `（${usage.toFixed(1)}%）`}` : "未取得"}；running=${load?.current.runningThreads ?? "n/a"}`,
    `- ${load ? `${load.windowSeconds.toFixed(1)} 秒负载` : "负载"}: QPS=${load?.rates.queriesPerSecond?.toFixed(1) ?? "n/a"}；TPS=${load?.rates.transactionsPerSecond?.toFixed(1) ?? "n/a"}；slow=${load?.delta.slowQueries ?? "n/a"}；tmp-disk=${load?.delta.temporaryDiskTables ?? "n/a"}；aborted-connect=${load?.delta.abortedConnects ?? "n/a"}`,
    `- 事务/锁: ${locks ? `active=${locks.activeTransactions}；waiting=${locks.waitingTransactions}；longest-wait=${locks.longestWaitSeconds}s；longest-transaction=${locks.longestTransactionSeconds}s` : "未取得"}`,
    "- 说明: DB 应用凭据只能取得 schema 逻辑使用量，物理磁盘总量与剩余量需要数据库平台指标。",
    "",
  ].join("\n");
}
