import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeHtml } from "../collect/output/report/components/content";
import type { CommandContext } from "../command";
import { writeOutput } from "../terminal/output";
import { OVERVIEW_REPORT_STYLE } from "../overview/report";
import type { CaseCheckResult } from "./cases/run";
import type { HealthResult } from "./flow";
function probeStatusLabel(status: string): string {
  return ({ skipped: "已跳过", "not-run": "未执行", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}
function casesHtml(checks: readonly CaseCheckResult[]): string {
  return `<h3>Case 检查（本次执行）</h3>` + (checks.length ? "" : "<p>本次没有适用的 Case 消费关系</p>") + checks.map(check =>
    `<h4>${escapeHtml(`${check.scope ?? "biz"} ${check.consumeExtension}${check.bindingId ? `/${check.bindingId}` : ""}`)} · ${escapeHtml(probeStatusLabel(check.status))}</h4>`
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
  writeOutput(`Health · ${result.checkedAt}\n`);
  for (const provider of result.providers) {
    writeOutput(`\n${provider.name} (${provider.namespace})\n`);
    if (provider.unsupported) writeOutput(`  ${provider.unsupported}\n`);
    for (const check of provider.checks) writeOutput(`  ${check.scope} ${check.description} [${check.id}]: ${probeStatusLabel(check.status)} · ${check.summary}\n`);
  }
}
export function writeHealthEvidence(result: HealthResult, context: CommandContext,
  directory = mkdtempSync(join(tmpdir(), "doctor-health-"))): string {
  writeFileSync(join(directory, "diagnosis.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  context.artifacts.add({ command: "health", path: directory }); return directory;
}
export function buildHealthHtml(result: HealthResult): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Doctor Health</title><style>${OVERVIEW_REPORT_STYLE}</style>
<h1>Doctor Health</h1><p>${escapeHtml(result.checkedAt)}</p>` + result.providers.map(provider =>
    `<h2>${escapeHtml(provider.name)}</h2>${provider.unsupported ? `<p>${escapeHtml(provider.unsupported)}</p>` : ""}` + provider.checks.map(check =>
      `<h3>${escapeHtml(check.scope)} ${escapeHtml(check.description)} · ${escapeHtml(probeStatusLabel(check.status))}</h3><p>${escapeHtml(check.summary)}</p>`
      + `<details><summary>检查证据</summary><pre>${escapeHtml(JSON.stringify(check, null, 2))}</pre></details>`
      + (check.cases ? casesHtml(check.cases) : "")).join("")).join("") + "</html>";
}
