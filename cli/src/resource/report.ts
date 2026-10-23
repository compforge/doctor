import { marked } from "marked";
import { summaryText as text } from "../command/summary";
import type { ResourceResult } from "./collect";

export function resourceSummary(result: ResourceResult): string {
  const lines = ["# Service 资源", "", result.mode === "catalog" ? "静态声明；未访问现场。" : "只读观测；资源状态不代表健康结论。", ""];
  if (!result.entries.length) lines.push("当前选择没有声明 Resource；由 Plugin 在 Service.resources 提供。", "");
  for (const entry of result.entries) {
    const snapshot = entry.snapshot;
    lines.push(`## ${text(entry.service)} · ${text(entry.resource.name)} (${text(entry.resource.id)})`,
      `- 关系：${entry.relationship === "manages" ? "管理" : "使用"}；类型：${text(entry.resource.kind)}`);
    if (entry.resource.description) lines.push(`- 说明：${text(entry.resource.description)}`);
    if (entry.summary?.text) lines.push(`- 解读：${text(entry.summary.text)}`);
    if (entry.issue) lines.push(`- 采集：${text(entry.issue.kind)} — ${text(entry.issue.message)}`);
    if (snapshot) {
      lines.push(`- 覆盖：${text(snapshot.coverage.status)}${snapshot.coverage.status === "complete" ? "" : ` — ${text(snapshot.coverage.reason)}`}`,
        `- 总量：${snapshot.totalCount ?? "未知"}；本页实例：${snapshot.instances?.length ?? "未提供"}`,
        `- 环境：${text(snapshot.environment)}；来源：${text(snapshot.source)}；时间：${text(snapshot.observedAt)}`,
        `- 范围：${text(JSON.stringify(snapshot.scope))}`);
      for (const measure of snapshot.measurements ?? []) lines.push(`- ${text(measure.name)}：${measure.value} ${text(measure.unit)}（${measure.scope === "total" ? "总量" : "已观测范围"}）`);
      if (snapshot.instances?.length) {
        lines.push("", "| 实例 ID | 名称 | 状态 |", "| --- | --- | --- |");
        for (const instance of snapshot.instances) lines.push(`| ${text(instance.ref.id)} | ${text(instance.name)} | ${text(instance.state)} |`);
      }
      if (snapshot.nextCursor) lines.push("", "存在后续页；完整 continuation 保存在 JSON 中。用同一 -s/--resource 和 --cursor 继续读取。");
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The summary escapes Plugin text before Markdown rendering; no raw Plugin HTML is accepted. */
export function resourceHtml(result: ResourceResult): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Service 资源</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font:15px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:10px;text-align:left;overflow-wrap:anywhere}h2{margin-top:32px}</style></head>
<body>${marked.parse(resourceSummary(result), { async: false })}</body></html>`;
}
