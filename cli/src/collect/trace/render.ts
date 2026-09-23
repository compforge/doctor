import { summaryText } from "../../command/serialization/navigation";
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
    lines.push(`- 时间范围: ${new Date(input.stats.minStartMs).toISOString()} ~ ${new Date(input.stats.maxEndMs).toISOString()}（跨度 ${durationMs}ms）`);
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
    for (const [service, count] of services) lines.push(`| ${service} | ${count} |`);
  }
  lines.push("", "## 步骤状态", "", "| step | status | reason |", "|---|---|---|", ...input.steps, "");
  lines.push("span 原始数据见 `spans.jsonl`（每行一个 jaeger-span `_source`，可直接作 trace 离线分析输入）。");
  lines.push("交互调用栈见 `trace.html`（node tree、节点详情、span attrs 与火焰图）。");
  return lines.join("\n");
}
