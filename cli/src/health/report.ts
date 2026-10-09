import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "../collect/output/report/components/content";
import type { CommandContext } from "../command";
import { writeOutput } from "../terminal/output";
import { buildOverviewStatisticsHtml, printOverviewStatistics, OVERVIEW_REPORT_STYLE } from "../overview/report";
import type { CaseCheckResult } from "./cases";
import type { HealthResult } from "./flow";

function casesHtml(checks: readonly CaseCheckResult[]): string {
  return `<h3>Case 检查（本次执行）</h3>` + (checks.length ? "" : "<p>本次没有适用的 Case 消费关系</p>") + checks.map(check =>
    `<h4>${escapeHtml(`${check.consumeExtension}${check.bindingId ? `/${check.bindingId}` : ""}`)} · ${escapeHtml(check.status)}</h4>`
    + `<p>${check.producer ? `提供方：${escapeHtml(check.producer.service)}/${escapeHtml(check.producer.source)}<br>` : ""}`
    + `消费方：${escapeHtml(check.consumer)}/${escapeHtml(check.workload ?? "未解析")}<br>`
    + `${escapeHtml(check.startedAt)} → ${escapeHtml(check.finishedAt ?? "进行中")}</p>`
    + (check.error ? `<pre>${escapeHtml(check.stage)}: ${escapeHtml(check.error)}</pre>` : "")
    + (check.truncated ? `<p>覆盖不足：${escapeHtml(check.truncated)}</p>` : "")
    + `<table><tr><th>Case / 入口</th><th>消费方实例</th><th>URL</th><th>结果</th><th>详情</th></tr>`
    + check.attempts.map(attempt => `<tr><td>${escapeHtml(attempt.caseId)} / ${escapeHtml(attempt.entrypoint)}${attempt.subject ? `<br>${escapeHtml(attempt.subject.label ?? attempt.subject.id)} (${escapeHtml(attempt.subject.id)})` : ""}</td>`
      + `<td>${escapeHtml(attempt.target.namespace)}/${escapeHtml(attempt.target.pod)}/${escapeHtml(attempt.target.container ?? "")}</td>`
      + `<td>${escapeHtml(attempt.url)}</td><td>${escapeHtml(attempt.status)} · HTTP ${attempt.observation.response.statusCode ?? "—"}</td>`
      + `<td>${attempt.observation.response.durationMs} ms${attempt.failure ? `<p>${escapeHtml(attempt.failure.summary)}（${escapeHtml(attempt.failure.certainty)}）</p>` : ""}<pre>${escapeHtml(attempt.observation.response.error ?? [...attempt.findings.map(finding => finding.kind), ...(attempt.sseCheck?.errors ?? []), ...(attempt.modelCheck?.errors ?? [])].join("\n"))}</pre>`
      + `<details><summary>请求证据</summary><pre>${escapeHtml(JSON.stringify(attempt, null, 2))}</pre></details></td></tr>`).join("")
    + `</table>`).join("");
}


export function printHealth(result: HealthResult): void {
  writeOutput(`Health · 统计窗口 ${result.query.window.from} → ${result.query.window.to} [from, to)；Case 为本次执行\n`);
  for (const summary of result.providers) {
    printOverviewStatistics(summary);
    if (summary.casesError) writeOutput(`  Case 检查失败：${summary.casesError}\n`);
    for (const check of summary.cases ?? []) {
      writeOutput(`  Case ${check.consumeExtension}${check.bindingId ? `/${check.bindingId}` : ""}: ${check.status} (${check.stage})\n`);
      if (check.error) writeOutput(`    ${check.error}\n`);
      if (check.truncated) writeOutput(`    覆盖不足：${check.truncated}\n`);
      for (const attempt of check.attempts) writeOutput(`    ${attempt.target.pod}/${attempt.target.container} → ${attempt.caseId}/${attempt.entrypoint}${attempt.subject ? ` [${attempt.subject.label ?? attempt.subject.id}]` : ""}: ${attempt.status}, HTTP ${attempt.observation.response.statusCode ?? "—"}, ${attempt.observation.response.durationMs} ms${attempt.failure ? ` · ${attempt.failure.summary}` : ""}${attempt.observation.response.error ? ` · ${attempt.observation.response.error}` : ""}${attempt.sseCheck?.errors.length ? ` · ${attempt.sseCheck.errors.join("; ")}` : ""}${attempt.modelCheck?.errors.length ? ` · ${attempt.modelCheck.errors.join("; ")}` : ""}\n`);
    }

  }
}

export function writeHealthEvidence(
  result: HealthResult, context: CommandContext,
  directory = mkdtempSync(join(tmpdir(), "doctor-health-")),
): string {
  writeFileSync(join(directory, "diagnosis.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  context.artifacts.add({ command: "health", path: directory });
  return directory;
}

export function buildHealthHtml(result: HealthResult): string {
  const sections = result.providers.map(summary => buildOverviewStatisticsHtml(summary)
    + (summary.casesError ? `<p>Case 检查失败：${escapeHtml(summary.casesError)}</p>` : "")
    + (summary.cases ? casesHtml(summary.cases) : "")).join("");
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Doctor Health</title>
<style>${OVERVIEW_REPORT_STYLE}</style>
<h1>Doctor Health</h1><p>统计窗口：${escapeHtml(result.query.window.from)} → ${escapeHtml(result.query.window.to)} [from, to)</p>
<p>Tenant: ${escapeHtml(result.query.tenantId ?? "全部")} · Case 为本次执行；不采集业务诊断数据。</p>${sections}</html>`;
}
