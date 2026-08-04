import type { TraceStats } from "./probe";

export function buildTraceSummary(input: {
  traceId: string;
  inputId?: string;
  resolvedAs?: "trace_id" | "tag";
  index: string;
  channel: string;
  count: number;
  downloaded: number;
  stats: TraceStats;
  steps: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# trace 采集摘要：${input.traceId}`, "");
  if (input.resolvedAs === "tag" && input.inputId) {
    lines.push(`- 输入 id: \`${input.inputId}\`（经 span tag 反查解析为本 trace，候选清单见 raw/resolve-id）`);
  }
  lines.push(`- index: \`${input.index}\`  通道: ${input.channel}`);
  lines.push(`- span 总数: ${input.count}  已下载: ${input.downloaded}`);
  if (input.stats.minStartMs !== undefined && input.stats.maxEndMs !== undefined) {
    const durationMs = Math.round(input.stats.maxEndMs - input.stats.minStartMs);
    lines.push(`- 时间范围: ${new Date(input.stats.minStartMs).toISOString()} ~ ${new Date(input.stats.maxEndMs).toISOString()}（跨度 ${durationMs}ms）`);
  }
  if (input.stats.errorSpans > 0) lines.push(`- error span 数: ${input.stats.errorSpans}`);
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
