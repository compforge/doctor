import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "../collect/output/report/components/content";
import type { OverviewCostEntry, OverviewCostResult } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { writeOutput } from "../terminal/output";
import type { OverviewProviderResult } from "./query";
import type { OverviewResult } from "./flow";

const COST_HEADERS = ["耗时项", "样本", "缺失/无效", "Min ms", "Avg ms", "P50 ms", "P95 ms", "Max ms"];
function costCells(entry: OverviewCostEntry): (string | number)[] {
  return [entry.label, entry.sampleCount, entry.missingCount,
    ...(["min", "avg", "p50", "p95", "max"] as const).map(key => {
      const value = entry.durationMs?.[key];
      return value === undefined ? "—" : Number(value.toFixed(2));
    })];
}
function costHtml(cost: OverviewCostResult): string {
  return `<h3>耗时统计</h3><p>${escapeHtml(cost.description)}</p>`
    + (cost.truncated ? `<p>已截断：${escapeHtml(cost.truncated.reason)}</p>` : "")
    + `<table><tr>${COST_HEADERS.map(label => `<th>${label}</th>`).join("")}</tr>`
    + cost.entries.map(entry => `<tr>${costCells(entry).map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")
    + `</table>${cost.entries.length ? "" : "<p>无耗时样本</p>"}`;
}

export const OVERVIEW_REPORT_STYLE = "body{font:15px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:10px;text-align:left;overflow-wrap:anywhere}h2{margin-top:32px}";

export function printOverviewStatistics(summary: OverviewProviderResult): void {
  writeOutput(`\n${summary.name}\n`);
  if (summary.costError) writeOutput(`  耗时查询失败：${summary.costError}\n`);
  if (summary.cost) {
    writeOutput(`  耗时统计 · ${summary.cost.description}\n    ${COST_HEADERS.join(" | ")}\n`);
    for (const entry of summary.cost.entries) writeOutput(`    ${costCells(entry).join(" | ")}\n`);
    if (!summary.cost.entries.length) writeOutput("    无耗时样本\n");
    if (summary.cost.truncated) writeOutput(`    已截断：${summary.cost.truncated.reason}\n`);
  }
  if (summary.error) writeOutput(`  查询失败：${summary.error}\n`);
  for (const facet of summary.facets) {
    writeOutput(`  ${facet.facetId} · ${facet.description}\n`);
    if (!facet.entries.length) writeOutput("    无值得注意的条目\n");
    for (const entry of facet.entries) writeOutput(`    ${entry.label}: ${entry.data}${entry.unit ? ` ${entry.unit}` : ""}\n`);
    if (facet.truncated) writeOutput(`    已截断：${facet.truncated.reason}\n`);
  }
}

export function printOverview(result: OverviewResult): void {
  writeOutput(`Overview · ${result.query.window.from} → ${result.query.window.to} [from, to)\n`);
  for (const summary of result.providers) printOverviewStatistics(summary);
  if (!result.providers.some(summary => summary.error || summary.facets.some(facet => facet.entries.length))) {
    writeOutput("当前结果中没有可选对象；完整系统情况请使用 doctor health。\n");
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

export function buildOverviewStatisticsHtml(
  summary: OverviewProviderResult, samples?: Pick<OverviewResult, "samples" | "sampleAllocations">,
): string {
  return `<h2>${escapeHtml(summary.name)}</h2>`
    + (summary.error ? `<p>查询失败：${escapeHtml(summary.error)}</p>` : "")
    + (summary.costError ? `<p>耗时查询失败：${escapeHtml(summary.costError)}</p>` : "")
    + (summary.cost ? costHtml(summary.cost) : "")
    + summary.facets.map((facet) => `<h3>${escapeHtml(facet.facetId)}</h3><p>${escapeHtml(facet.description)}</p>`
      + (facet.truncated ? `<p>已截断：${escapeHtml(facet.truncated.reason)}</p>` : "")
      + `<table><tr><th>Entry</th><th>数据</th>${samples ? "<th>代表对象 / 采样结果</th>" : ""}</tr>`
      + facet.entries.map((entry) => {
        const matches = (item: { namespace: string; facetId: string; entryKey: string }) => (
          item.namespace === summary.namespace && item.facetId === facet.facetId && item.entryKey === entry.key
        );
        const allocation = samples?.sampleAllocations.find(matches);
        const selectedSamples = samples?.samples.filter(matches) ?? [];
        const sampled = selectedSamples.map((sample) => (
          `${escapeHtml(sample.bizId ?? sample.error ?? "未知结果")}`
          + (sample.source ? `<br>${escapeHtml(sample.source.kind)}: ${escapeHtml(sample.source.value)}` : "")
        )).join("<br><br>");
        const sampling = !allocation
          ? (entry.canSample ? "未查询样本" : "不支持采样")
          : allocation.count === 0
          ? "配额为 0（未查询）"
          : `分配 ${allocation.count} 个样本<br>${sampled || "无采样结果"}`;
        return `<tr><td>${escapeHtml(entry.label)}</td><td>${escapeHtml(entry.data)} ${escapeHtml(entry.unit ?? "")}</td>`
          + (samples ? `<td>${sampling}</td>` : "") + "</tr>";
      }).join("") + `</table>${facet.entries.length ? "" : "<p>无值得注意的条目</p>"}`).join("");
}

export function buildOverviewHtml(result: OverviewResult): string {
  const sections = result.providers.map(summary => buildOverviewStatisticsHtml(summary, result)).join("");
  const empty = result.providers.some(summary => summary.error || summary.facets.some(facet => facet.entries.length))
    ? "" : "<p>当前结果中没有可选对象；完整系统情况请使用 doctor health。</p>";
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Doctor Overview</title>
<style>${OVERVIEW_REPORT_STYLE}</style>
<h1>Doctor Overview</h1><p>${escapeHtml(result.query.window.from)} → ${escapeHtml(result.query.window.to)} [from, to)</p>
<p>Tenant: ${escapeHtml(result.query.tenantId ?? "全部")} · 采集状态: ${escapeHtml(result.collection)} ${escapeHtml(result.collectionError ?? "")}</p>${empty}${sections}</html>`;
}
