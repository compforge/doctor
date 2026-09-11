import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "../collect/output/report/components/content";
import type { CommandContext } from "../command";
import { terminalStdout } from "../terminal/output";
import type { OverviewResult } from "./flow";

export function printOverview(result: OverviewResult): void {
  terminalStdout.write(`Overview · ${result.query.window.from} → ${result.query.window.to} [from, to)\n`);
  for (const service of result.services) {
    terminalStdout.write(`\n${service.service}\n`);
    if (service.error) terminalStdout.warning(`  查询失败：${service.error}\n`);
    for (const facet of service.facets) {
      terminalStdout.write(`  ${facet.facetId} · ${facet.description}\n`);
      if (!facet.entries.length) terminalStdout.write("    无值得注意的条目\n");
      for (const entry of facet.entries) terminalStdout.write(`    ${entry.label}: ${entry.data}${entry.unit ? ` ${entry.unit}` : ""}\n`);
      if (facet.truncated) terminalStdout.warning(`    已截断：${facet.truncated.reason}\n`);
    }
  }
}

export function writeOverviewEvidence(
  result: OverviewResult, context: CommandContext,
  directory = mkdtempSync(join(tmpdir(), "doctor-overview-")),
): string {
  writeFileSync(join(directory, "diagnosis.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  context.artifacts.add({ command: "overview", path: directory });
  return directory;
}

export function buildOverviewHtml(result: OverviewResult): string {
  const sections = result.services.map((service) => `<h2>${escapeHtml(service.service)}</h2>`
    + (service.error ? `<p>查询失败：${escapeHtml(service.error)}</p>` : "")
    + service.facets.map((facet) => `<h3>${escapeHtml(facet.facetId)}</h3><p>${escapeHtml(facet.description)}</p>`
      + (facet.truncated ? `<p>已截断：${escapeHtml(facet.truncated.reason)}</p>` : "")
      + `<table><tr><th>Entry</th><th>数据</th><th>代表请求 / 采样结果</th></tr>`
      + facet.entries.map((entry) => {
        const matches = (item: { service: string; facetId: string; entryKey: string }) => (
          item.service === service.service && item.facetId === facet.facetId && item.entryKey === entry.key
        );
        const allocation = result.sampleAllocations.find(matches);
        const samples = result.samples.filter(matches);
        const sampled = samples.map((sample) => (
          `${escapeHtml(sample.bizId ?? sample.error ?? "未知结果")}`
          + (sample.source ? `<br>${escapeHtml(sample.source.kind)}: ${escapeHtml(sample.source.value)}` : "")
        )).join("<br><br>");
        const sampling = !allocation
          ? (entry.canSample ? "未采集" : "不支持采样")
          : allocation.count === 0
          ? "已选择；本轮采样配额为 0"
          : `分配 ${allocation.count} 个样本<br>${sampled || "无采样结果"}`;
        return `<tr><td>${escapeHtml(entry.label)}</td><td>${escapeHtml(entry.data)} ${escapeHtml(entry.unit ?? "")}</td>`
          + `<td>${sampling}</td></tr>`;
      }).join("") + `</table>${facet.entries.length ? "" : "<p>无值得注意的条目</p>"}`).join("")).join("");
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Doctor Overview</title>
<style>body{font:15px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:10px;text-align:left;overflow-wrap:anywhere}h2{margin-top:32px}</style>
<h1>Doctor Overview</h1><p>${escapeHtml(result.query.window.from)} → ${escapeHtml(result.query.window.to)} [from, to)</p>
<p>Tenant: ${escapeHtml(result.query.tenantId ?? "全部")} · 采集状态: ${escapeHtml(result.collection)} ${escapeHtml(result.collectionError ?? "")}</p>${sections}</html>`;
}
