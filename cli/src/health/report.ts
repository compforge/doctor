import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "../collect/output/report/components/content";
import type { CommandContext } from "../command";
import { writeOutput } from "../terminal/output";
import { OVERVIEW_REPORT_STYLE } from "../overview/report";
import type { CaseCheckResult } from "./biz/run";
import { dataSourceHealthHtml } from "../datasource/health/report";
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
  if (result.notRunScopes?.length) writeOutput(`未执行层级：${result.notRunScopes.map(scope => scope === "business" ? "biz" : scope).join(", ")}\n`);
  writeOutput(`Health · 本次巡检${result.checkedAt ? ` · ${result.checkedAt}` : ""}\n`);
  for (const summary of result.providers) {
    writeOutput(`\n${summary.name} (${summary.namespace})\n`);
    if (summary.unsupported) writeOutput(`  未执行：${summary.unsupported}\n`);
    for (const check of summary.probes ?? []) {
      writeOutput(`  ${check.scope} Probe ${check.probe}: ${check.status === "not-run" ? "未执行" : check.status === "cancelled" ? "已取消" : check.status}${check.reason ? ` · ${check.reason}` : ""}\n`);
      for (const finding of check.findings) writeOutput(`    ${finding.severity}: ${finding.message}\n`);
    }
    for (const check of summary.endpoints ?? []) writeOutput(`  Endpoint ${check.source} · ${check.instance?.pod ?? check.workload ?? summary.name}: ${check.status === "none" ? "没有对外 Endpoint 依赖" : check.status}${check.endpoint ? ` · ${check.endpoint.host}:${check.endpoint.port}` : ""}${check.error ? ` · ${check.error.kind ?? ""}/${check.error.code ?? ""} ${check.error.message}` : ""}\n`);
    for (const check of summary.dataSources ?? []) writeOutput(`  数据源 ${check.service}/${check.dataSource}: ${check.error ?? check.evidence?.health.summary ?? "未取得证据"}\n`);
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
  const sections = result.providers.map(summary => `<h2>${escapeHtml(summary.name)}</h2><p>${escapeHtml(summary.namespace)}</p>`
    + (summary.unsupported ? `<p>未执行：${escapeHtml(summary.unsupported)}</p>` : "")
    + (summary.probes ?? []).map(check => `<h3>${escapeHtml(check.scope)} Probe ${escapeHtml(check.probe)} · ${escapeHtml(check.status === "not-run" ? "未执行" : check.status === "cancelled" ? "已取消" : check.status)}</h3>`
      + `<p>${escapeHtml(check.reason ?? "")}</p>` + check.findings.map(finding => `<p>${escapeHtml(finding.severity)}: ${escapeHtml(finding.message)}</p>`).join("")
      + `<details><summary>Observation</summary><pre>${escapeHtml(JSON.stringify(check.observations, null, 2))}</pre></details>`).join("")
    + (summary.endpoints ?? []).map(check => `<h3>Endpoint ${escapeHtml(check.source)} · ${escapeHtml(check.status === "none" ? "没有对外 Endpoint 依赖" : check.status)}</h3><pre>${escapeHtml(JSON.stringify(check, null, 2))}</pre>`).join("")
    + (summary.dataSources ?? []).map(check => `<h3>数据源 ${escapeHtml(check.service)}/${escapeHtml(check.dataSource)}</h3>`
      + (check.evidence ? dataSourceHealthHtml(check.evidence) : `<p>探测失败：${escapeHtml(check.error ?? "未取得证据")}</p>`)).join("")
    + (summary.casesError ? `<p>Case 检查失败：${escapeHtml(summary.casesError)}</p>` : "")
    + (summary.cases ? casesHtml(summary.cases) : "")).join("");
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Doctor Health</title>
<style>${OVERVIEW_REPORT_STYLE}</style>
<h1>Doctor Health</h1><p>本次巡检${result.checkedAt ? `：${escapeHtml(result.checkedAt)}` : ""}</p>
${result.notRunScopes?.length ? `<p>未执行层级：${escapeHtml(result.notRunScopes.map(scope => scope === "business" ? "biz" : scope).join(", "))}</p>` : ""}
<p>Tenant: ${escapeHtml(result.query.tenantId ?? "全部")} · Case 为本次执行；不采集业务诊断数据。</p>${sections}</html>`;
}
