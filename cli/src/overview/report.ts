import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "../collect/output/report/components/content";
import type { OverviewCostEntry, OverviewCostResult } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { writeOutput } from "../terminal/output";
import type { CaseCheckResult } from "./cases";
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

function casesHtml(checks: readonly CaseCheckResult[]): string {
  return `<h3>Case 检查（本次执行）</h3>` + (checks.length ? "" : "<p>本次没有适用的 Case 消费关系</p>") + checks.map(check =>
    `<h4>${escapeHtml(`${check.consumeExtension}${check.bindingId ? `/${check.bindingId}` : ""}`)} · ${escapeHtml(check.status)}</h4>`
    + `<p>${check.producer ? `提供方：${escapeHtml(check.producer.namespace)}/${escapeHtml(check.producer.extension)}<br>` : ""}`
    + `消费方：${escapeHtml(check.consumer)}/${escapeHtml(check.workload ?? "未解析")}<br>`
    + `${escapeHtml(check.startedAt)} → ${escapeHtml(check.finishedAt ?? "进行中")}</p>`
    + (check.error ? `<pre>${escapeHtml(check.stage)}: ${escapeHtml(check.error)}</pre>` : "")
    + (check.truncated ? `<p>覆盖不足：${escapeHtml(check.truncated)}</p>` : "")
    + `<table><tr><th>Case / 入口</th><th>消费方实例</th><th>URL</th><th>结果</th><th>详情</th></tr>`
    + check.attempts.map(attempt => `<tr><td>${escapeHtml(attempt.caseId)} / ${escapeHtml(attempt.entrypoint)}</td>`
      + `<td>${escapeHtml(attempt.target.namespace)}/${escapeHtml(attempt.target.pod)}/${escapeHtml(attempt.target.container ?? "")}</td>`
      + `<td>${escapeHtml(attempt.url)}</td><td>${escapeHtml(attempt.status)} · HTTP ${attempt.observation.response.statusCode ?? "—"}</td>`
      + `<td>${attempt.observation.response.durationMs} ms${attempt.failure ? `<p>${escapeHtml(attempt.failure.summary)}（${escapeHtml(attempt.failure.certainty)}）</p>` : ""}<pre>${escapeHtml(attempt.observation.response.error ?? [...attempt.findings.map(finding => finding.kind), ...(attempt.sseCheck?.errors ?? [])].join("\n"))}</pre>`
      + `<details><summary>请求证据</summary><pre>${escapeHtml(JSON.stringify(attempt, null, 2))}</pre></details></td></tr>`).join("")
    + `</table>`).join("");
}

export function printOverview(result: OverviewResult): void {
  writeOutput(`Overview · ${result.query.window.from} → ${result.query.window.to} [from, to)\n`);
  for (const summary of result.providers) {
    writeOutput(`\n${summary.name}\n`);
    if (summary.casesError) writeOutput(`  Case 检查失败：${summary.casesError}\n`);
    for (const check of summary.cases ?? []) {
      writeOutput(`  Case ${check.consumeExtension}${check.bindingId ? `/${check.bindingId}` : ""}: ${check.status} (${check.stage})\n`);
      if (check.error) writeOutput(`    ${check.error}\n`);
      if (check.truncated) writeOutput(`    覆盖不足：${check.truncated}\n`);
      for (const attempt of check.attempts) writeOutput(`    ${attempt.target.pod}/${attempt.target.container} → ${attempt.caseId}/${attempt.entrypoint}: ${attempt.status}, HTTP ${attempt.observation.response.statusCode ?? "—"}, ${attempt.observation.response.durationMs} ms${attempt.failure ? ` · ${attempt.failure.summary}` : ""}${attempt.observation.response.error ? ` · ${attempt.observation.response.error}` : ""}${attempt.sseCheck?.errors.length ? ` · ${attempt.sseCheck.errors.join("; ")}` : ""}\n`);
    }
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
  const sections = result.providers.map((summary) => `<h2>${escapeHtml(summary.name)}</h2>`
    + (summary.error ? `<p>查询失败：${escapeHtml(summary.error)}</p>` : "")
    + (summary.costError ? `<p>耗时查询失败：${escapeHtml(summary.costError)}</p>` : "")
    + (summary.cost ? costHtml(summary.cost) : "")
    + (summary.casesError ? `<p>Case 检查失败：${escapeHtml(summary.casesError)}</p>` : "")
    + (summary.cases ? casesHtml(summary.cases) : "")
    + summary.facets.map((facet) => `<h3>${escapeHtml(facet.facetId)}</h3><p>${escapeHtml(facet.description)}</p>`
      + (facet.truncated ? `<p>已截断：${escapeHtml(facet.truncated.reason)}</p>` : "")
      + `<table><tr><th>Entry</th><th>数据</th><th>代表请求 / 采样结果</th></tr>`
      + facet.entries.map((entry) => {
        const matches = (item: { namespace: string; facetId: string; entryKey: string }) => (
          item.namespace === summary.namespace && item.facetId === facet.facetId && item.entryKey === entry.key
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
          ? "配额为 0（未采集）"
          : `分配 ${allocation.count} 个样本<br>${sampled || "无采样结果"}`;
        return `<tr><td>${escapeHtml(entry.label)}</td><td>${escapeHtml(entry.data)} ${escapeHtml(entry.unit ?? "")}</td>`
          + `<td>${sampling}</td></tr>`;
      }).join("") + `</table>${facet.entries.length ? "" : "<p>无值得注意的条目</p>"}`).join("")).join("");
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Doctor Overview</title>
<style>body{font:15px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:10px;text-align:left;overflow-wrap:anywhere}h2{margin-top:32px}</style>
<h1>Doctor Overview</h1><p>${escapeHtml(result.query.window.from)} → ${escapeHtml(result.query.window.to)} [from, to)</p>
<p>Tenant: ${escapeHtml(result.query.tenantId ?? "全部")} · 采集状态: ${escapeHtml(result.collection)} ${escapeHtml(result.collectionError ?? "")}</p>${sections}</html>`;
}
