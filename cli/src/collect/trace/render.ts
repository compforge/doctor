import { summaryText } from "../../command/summary";
import type { TraceStats } from "./probe";
export { renderTraceSnapshot as renderTraceEvidence } from "./snapshot";

export function buildTraceSummary(input: {
  traceId: string;
  inputId?: string;
  selectionMode?: "time_range" | "trace_id" | "biz_id";
  resolvedAs?: string;
  index: string;
  channel: string;
  count: number;
  downloaded: number;
  stats: TraceStats;
  steps: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# trace 采集摘要：${input.traceId}`, "");
  if (input.inputId) {
    const mode = input.selectionMode ?? (input.resolvedAs === "trace_id" ? "trace_id" : "biz_id");
    if (mode === "trace_id") lines.push(`- 输入 trace ID: \`${input.inputId}\``);
    else if (mode === "time_range") lines.push(`- 时间范围选中的 trace ID: \`${input.inputId}\``);
    else lines.push(`- 业务 ID: \`${input.inputId}\`（Plugin 按 ${input.resolvedAs ?? "unknown"} 解析）`);
  }
  lines.push(`- index: \`${input.index}\`  通道: ${input.channel}`);
  lines.push(`- span 总数: ${input.count}  已下载: ${input.downloaded}`);
  if (input.stats.minStartMs !== undefined && input.stats.maxEndMs !== undefined) {
    const durationMs = Math.round(input.stats.maxEndMs - input.stats.minStartMs);
    lines.push(`- 已采集 span 覆盖范围: ${new Date(input.stats.minStartMs).toISOString()} ~ ${new Date(input.stats.maxEndMs).toISOString()}（跨度 ${durationMs}ms；不代表问答耗时）`);
  }
  if (input.stats.errorSpans > 0) lines.push(`- error span 数: ${input.stats.errorSpans}`);
  if (input.stats.errors?.length) {
    lines.push("", "## 异常时间线", "", "按异常事件时间排序；缺少事件时间时使用 span 结束时间。时间先后不代表根因关系。", "",
      "| 时间（UTC） | Service | Operation | span ID | 错误 |", "|---|---|---|---|---|");
    for (const error of input.stats.errors) lines.push(`| ${error.timeMs === undefined ? "未知" : new Date(error.timeMs).toISOString()} | ${summaryText(error.service)} | ${summaryText(error.operation)} | ${summaryText(error.spanId)} | ${summaryText(error.message)} |`);
    if (input.stats.errorSpans > input.stats.errors.length) lines.push(`另有 ${input.stats.errorSpans - input.stats.errors.length} 个 error span，见完整 spans。`);
    lines.push("", "[原始 spans](spans.jsonl)，按上表 span ID 定位。");
  }
  const services = Object.entries(input.stats.services).sort((a, b) => b[1] - a[1]);
  if (services.length) {
    lines.push("", "## 按 service 分布", "", "| service | spans |", "|---|---|");
    for (const [service, count] of services) lines.push(`| ${summaryText(service, 160)} | ${count} |`);
  }
  const operations = [...input.stats.operations.values()].sort((a, b) => b.count - a.count
    || a.service.localeCompare(b.service) || a.operation.localeCompare(b.operation));
  if (operations.length) {
    const time = (value: number | undefined) => value === undefined ? "未知" : new Date(value).toISOString();
    lines.push("", "## 按 Service / Operation 分组", "",
      "仅统计已采集 spans，按数量降序展示前 20 组；时间为 UTC。重复 span 可提示重试或轮询，需结合原始证据确认。",
      "首次/末次开始用于定位重复调用的分布，最晚结束用于识别较早开始但持续较久的调用。", "",
      "| Service | Operation | spans | 首次开始（UTC） | 末次开始（UTC） | 最晚结束（UTC） |",
      "|---|---|---|---|---|---|");
    for (const group of operations.slice(0, 20)) lines.push(`| ${summaryText(group.service, 160)} | ${summaryText(group.operation, 160)} | ${group.count} | ${time(group.firstStartMs)} | ${time(group.lastStartMs)} | ${time(group.lastEndMs)} |`);
    if (operations.length > 20) lines.push(`另有 ${operations.length - 20} 组未展示，见 [原始 spans](spans.jsonl)。`);
  }
  lines.push("", "## 步骤状态", "", "| step | status | reason |", "|---|---|---|", ...input.steps, "");
  lines.push("span 原始数据见 `spans.jsonl`（每行一个 jaeger-span `_source`，可直接作 trace 离线分析输入）。");
  lines.push("交互调用栈见 `trace.html`（node tree、节点详情、span attrs 与火焰图）。");
  return lines.join("\n");
}
