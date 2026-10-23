import { marked } from "marked";
import { projectSummary, summaryText as text } from "../command/summary";
import type { ResourceResult } from "./collect";

/** @spec Summary and detailed views share evidence; only the detailed view expands instances. */
function resourceMarkdown(result: ResourceResult, detail: boolean): string {
  const lines = ["# Service 资源", "", result.mode === "catalog" ? "静态声明；未访问现场。" : "只读观测；资源状态不代表健康结论。", ""];
  if (!result.entries.length) lines.push("当前选择没有声明 Resource；由 Plugin 在 Service.resources 提供。", "");
  for (const entry of result.entries) {
    const snapshot = entry.snapshot;
    lines.push(`## ${text(entry.service)} · ${text(entry.resource.name)} (${text(entry.resource.id)})`,
      `- 关系：${entry.relationship === "manages" ? "管理" : "使用"}；类型：${text(entry.resource.kind)}`);
    if (entry.resource.description) lines.push(`- 说明：${text(entry.resource.description)}`);
    if (entry.summary && snapshot) {
      const projection = projectSummary(entry.summary, snapshot);
      if (projection.text) lines.push(`- 解读：${text(projection.text)}`);
      for (const field of projection.fields) lines.push(`- ${text(field.label)}：${text(field.value)}`);
      if (projection.omitted) lines.push(`- 另有 ${projection.omitted} 个摘要字段，见原始证据。`);
    }
    if (entry.issue) lines.push(`- 采集：${text(entry.issue.kind)} — ${text(entry.issue.message)}`);
    if (snapshot) {
      lines.push(`- 覆盖：${text(snapshot.coverage.status)}${snapshot.coverage.status === "complete" ? "" : ` — ${text(snapshot.coverage.reason)}`}`,
        `- 总量：${snapshot.totalCount ?? "未知"}；本页实例：${snapshot.instances?.length ?? "未提供"}`,
        `- 环境：${text(snapshot.environment)}；来源：${text(snapshot.source)}；时间：${text(snapshot.observedAt)}`,
        `- 范围：${text(JSON.stringify(snapshot.scope))}`);
      for (const measure of snapshot.measurements ?? []) lines.push(`- ${text(measure.name)}：${measure.value} ${text(measure.unit)}（${measure.scope === "total" ? "总量" : "已观测范围"}）`);
      // A provider may supply independent aggregates. Without them, count only the retained page.
      if (!snapshot.measurements?.length && snapshot.instances?.length) {
        const states = new Map<string, number>();
        for (const instance of snapshot.instances) {
          const state = instance.state?.trim() || "未知";
          states.set(state, (states.get(state) ?? 0) + 1);
        }
        lines.push(`- 本页状态（已观测实例）：${[...states].map(([state, count]) => `${text(state)} ${count}`).join(" · ")}`);
      }
      if (detail && snapshot.instances?.length) {
        lines.push("", "| 实例 ID | 名称 | 状态 |", "| --- | --- | --- |");
        for (const instance of snapshot.instances) lines.push(`| ${text(instance.ref.id)} | ${text(instance.name)} | ${text(instance.state)} |`);
      }
      if (snapshot.nextCursor) lines.push("", "存在后续页；完整 continuation 保存在 JSON 中。用同一 -s/--resource 和 --cursor 继续读取。");
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function resourceSummary(result: ResourceResult): string { return resourceMarkdown(result, false); }
export function resourceText(result: ResourceResult): string { return resourceMarkdown(result, true); }

/** The summary escapes Plugin text before Markdown rendering; no raw Plugin HTML is accepted. */
export function resourceHtml(result: ResourceResult): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Service 资源</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font:15px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:10px;text-align:left;overflow-wrap:anywhere}h2{margin-top:32px}</style></head>
<body>${marked.parse(resourceText(result), { async: false })}</body></html>`;
}
