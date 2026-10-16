import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../../command";
import { escapeHtml } from "../../collect/output/report/components/content";
import type { DataSourceHealthResult } from "./extension";

export interface DataSourceHealthEvidence {
  target: Record<string, unknown>;
  health: DataSourceHealthResult;
}
export function dataSourceHealthHtml(evidence: DataSourceHealthEvidence): string {
  const { health, target } = evidence;
  return `<h2>OpenSearch 健康（本次探测）</h2><p>${escapeHtml(health.startedAt)} → ${escapeHtml(health.finishedAt)}</p>`
    + `<pre>${escapeHtml(JSON.stringify(target, null, 2))}</pre><p>采集：${escapeHtml(health.status)}</p>`
    + `<p>${escapeHtml(health.summary)}</p><ul>${health.probes.map(probe =>
      `<li>${escapeHtml(probe.id)}: ${escapeHtml(probe.status)} ${escapeHtml(probe.reason ?? "")}</li>`).join("")}</ul>`
    + `<p>健康异常是存储链路的辅助证据，不能单独证明某条请求未产生或未上报 span。</p>`;
}
export function writeDataSourceHealth(context: CommandContext, evidence: DataSourceHealthEvidence) {
  const directory = join(mkdtempSync(join(tmpdir(), "doctor-datasource-health-")), "health");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "health.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  writeFileSync(join(directory, "summary.md"), `# OpenSearch 健康（本次探测）\n\n${evidence.health.summary}\n`);
  return context.artifacts.add({ command: "datasource-health", path: directory });
}
