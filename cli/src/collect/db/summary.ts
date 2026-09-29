import type { DatabaseQueryResult } from "@compforge/harness-toolbox/mysql";
import type { CommandStatus } from "../../command";
import { summaryText, summaryValue } from "../../command/summary";
import type { DbAction } from "./input";
import type { DbDiscovery, DbSelection } from "./discovery";
import type { ProviderResolution } from "./providers";

const previewRows = 10;
const previewColumns = 8;
const previewCellLength = 120;

function cell(value: unknown, limit = 512): string {
  return summaryText((summaryValue(value) ?? "—").replace(/[\x00-\x1f\x7f-\x9f]/g, " "), limit);
}

/** Discovery is runtime evidence; descriptions explain declarations, not availability or permissions. */
export function databaseDiscoverySummary(discovery: readonly DbDiscovery[], failures: ProviderResolution["failures"]): string {
  const lines = ["| DataSource | Database | Description | 状态 |", "| --- | --- | --- | --- |"];
  for (const { provider, result, error } of discovery) {
    const databases = (result?.rows ?? []).map(row => row.database_name ?? row.Database).filter((name): name is string => typeof name === "string");
    const state = error ?? (result?.truncated ? "partial（清单截断）" : databases.length ? "ok" : "未发现可见数据库");
    for (const source of provider.dataSources) {
      for (const database of databases.length ? databases : ["—"]) {
        if (lines.length >= previewRows + 2) return `${lines.join("\n")}\n\n发现清单仅预览前 ${previewRows} 条；完整已采集清单见证据。`;
        lines.push(`| ${cell(source.id)} | ${cell(database)} | ${cell(source.description ?? "—")} | ${cell(state)} |`);
      }
    }
  }
  for (const failure of failures) {
    if (lines.length >= previewRows + 2) return `${lines.join("\n")}\n\n发现清单仅预览前 ${previewRows} 条；完整已采集清单见证据。`;
    lines.push(`| ${cell(failure.id)} | — | ${cell(failure.description ?? "—")} | ${cell(failure.reason)} |`);
  }
  return lines.join("\n");
}

interface DatabaseSummaryInput {
  service?: string;
  action: DbAction;
  status: CommandStatus;
  reason?: string;
  selection?: DbSelection;
  queryAttempted: boolean;
  queryResult?: DatabaseQueryResult;
  discovery: readonly DbDiscovery[];
  failures: ProviderResolution["failures"];
}

/** Preview limits affect presentation only; raw rows and query truncation remain unchanged. */
function resultPreview(result: DatabaseQueryResult): string {
  if (!result.rows.length) return "无返回行。";
  const columns = result.columns.length ? result.columns : Object.keys(result.rows[0]!);
  const shownColumns = columns.slice(0, previewColumns);
  const shownRows = result.rows.slice(0, previewRows);
  const lines = [
    `| ${shownColumns.map(column => cell(column, previewCellLength)).join(" | ")} |`,
    `| ${shownColumns.map(() => "---").join(" | ")} |`,
    ...shownRows.map(row => `| ${shownColumns.map(column => cell(row[column], previewCellLength)).join(" | ")} |`),
    "", `预览 ${shownRows.length}/${result.rows.length} 行、${shownColumns.length}/${columns.length} 列；单元格最多 ${previewCellLength} 字符。`,
  ];
  return lines.join("\n");
}

function truncation(result: DatabaseQueryResult): string {
  return result.truncated ? `是（${result.truncation === "rows" ? "行数限制" : result.truncation === "bytes" ? "字节限制" : "查询限制"}）` : "否";
}

/** One local evidence summary serves terminal delivery and reports, without issuing another query. */
export function databaseSummary(input: DatabaseSummaryInput): string {
  const { selection, queryResult } = input;
  const isQuery = input.action === "query" || input.action === "create-table";
  const lines = ["# 数据库取证", "", `- Service：${cell(input.service)}`,
    `- 操作：${input.action}`, `- 状态：${input.status}`];
  if (input.reason) lines.push(`- 原因：${cell(input.reason)}`);
  if (selection) {
    const { host, port } = selection.provider.target;
    lines.push(`- 选中目标：${cell(host)}:${port} / ${cell(selection.database)}${selection.table ? ` / ${cell(selection.table)}` : ""}`,
      `- 访问来源：${cell(selection.provider.id)}`);
  } else lines.push(`- 选中目标：${isQuery ? "未选定" : "库表发现（各来源见下）"}`);
  // Calling a client is not proof that the server received or completed a failed query.
  lines.push(`- 目标 SQL：${queryResult ? "已执行并返回结果" : input.queryAttempted ? "已尝试执行，未取得结果（服务端完成状态未知）" : isQuery ? "未执行" : "不适用（仅库表发现）"}`);
  if (isQuery) {
    lines.push(`- 返回行数：${queryResult ? queryResult.rows.length : "未知（未取得结果）"}`,
      `- 查询结果截断：${queryResult ? truncation(queryResult) : "未知（未取得结果）"}`);
    if (queryResult) lines.push("", "## 结果预览", "", resultPreview(queryResult));
  } else {
    const observed = input.discovery.filter(item => item.result);
    const rowCount = observed.reduce((count, item) => count + item.result!.rows.length, 0);
    lines.push(`- 发现行数：${rowCount}（各来源合计，可能重复）`,
      `- 发现结果截断：${observed.some(item => item.result!.truncated) ? "是" : observed.length === input.discovery.length && !input.failures.length && observed.length ? "否" : "未知或部分来源未取得结果"}`);
    if (input.action === "databases") lines.push("", databaseDiscoverySummary(input.discovery, input.failures));
    else for (const item of input.discovery.slice(0, 3)) {
      lines.push("", `## ${cell(item.provider.id)} · ${cell(item.provider.target.host)}:${item.provider.target.port}`, "");
      if (item.result) lines.push(resultPreview(item.result));
      if (item.error) lines.push(`原因：${cell(item.error)}`);
    }
    if (input.action === "tables" && input.discovery.length > 3) lines.push("", "其余来源见完整证据。");
  }
  const failures = [...input.failures.map(item => `${item.id}: ${item.reason}`),
    ...input.discovery.filter(item => item.error).map(item => `${item.provider.id}: ${item.error}`)];
  if (failures.length) lines.push("", "## 访问失败", "", ...failures.slice(0, 3).map(reason => `- ${cell(reason)}`),
    ...(failures.length > 3 ? ["- 其余失败见完整证据。"] : []));
  lines.push("", "完整已采集结果见证据目录；预览省略不代表查询结果截断。", "");
  return lines.join("\n");
}
