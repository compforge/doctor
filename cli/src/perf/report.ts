import { CommandStatus } from "../command";
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import type { PerfEvidenceSample, PerfResult } from "./model";

export function perfEvidenceStatus(result: PerfResult): "complete" | "partial" {
  return result.metric.status === CommandStatus.Ok
    && result.samples.length > 0
    && result.samples.every((sample) => sample.trace.status === CommandStatus.Ok && sample.log?.status === CommandStatus.Ok)
    ? "complete"
    : "partial";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function link(path: string, label: string): string {
  return `<a href="${escapeHtml(basename(path))}">${escapeHtml(label)}</a>`;
}

function sampleRow(sample: PerfEvidenceSample): string {
  return `<tr><td>${escapeHtml(sample.armRunId)}</td><td>${escapeHtml(sample.caseId ?? "-")}</td>`
    + `<td>${escapeHtml(sample.correlationKey)}</td>`
    + `<td><code>${escapeHtml(sample.correlationId)}</code></td>`
    + `<td>${sample.firstTokenMs === undefined ? "-" : escapeHtml(sample.firstTokenMs.toFixed(0))}</td>`
    + `<td>${escapeHtml(sample.durationMs.toFixed(0))}</td>`
    + `<td>${escapeHtml(sample.errorKind ?? "-")}</td>`
    + `<td>${sample.trace.status === CommandStatus.Ok ? "见顶部 trace Tab" : `trace(${sample.trace.status})`}</td>`
    + `<td>${sample.log?.status === CommandStatus.Ok ? "见顶部 log Tab" : `log(${sample.log?.status ?? "not-run"})`}</td></tr>`;
}

function orderedFacetValues(result: PerfResult, facet: string, values: string[]): string[] {
  const declared = result.caseFacets?.[facet];
  if (!declared?.ordered || !declared.values) return values.sort();
  const order = new Map(declared.values.map((value, index) => [value, index]));
  return values.sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.localeCompare(right);
  });
}

export function writePerfReport(result: PerfResult): string {
  const evidenceStatus = perfEvidenceStatus(result);
  const armRows = result.run.executions.map((armRun) => {
    const stats = armRun.windows.find((window) => window.id === "measurement")?.request;
    const firstToken = stats?.metrics.first_token_ms;
    return `<tr><td>${escapeHtml(armRun.id)}</td><td>${escapeHtml(Math.max(armRun.arm.load.max_inflight, ...(armRun.arm.load.stages ?? []).map(stage => stage.max_inflight)))}</td>`
      + `<td>${escapeHtml(stats?.n ?? 0)}</td><td>${escapeHtml(stats?.throughput_rps.toFixed(2) ?? "0")}</td>`
      + `<td>${escapeHtml(stats?.error_rate === undefined ? "-" : `${(stats.error_rate * 100).toFixed(1)}%`)}</td>`
      + `<td>${escapeHtml(firstToken?.p50.toFixed(0) ?? "-")}</td>`
      + `<td>${escapeHtml(firstToken?.p95.toFixed(0) ?? "-")}</td>`
      + `<td>${escapeHtml(firstToken?.p99.toFixed(0) ?? "-")}</td>`
      + `<td>${escapeHtml(armRun.stop.reason)}</td></tr>`;
  }).join("\n");
  const caseRows = result.run.executions.flatMap((armRun) => {
    const window = armRun.windows.find((candidate) => candidate.id === "measurement");
    return Object.entries(window?.by_case ?? {}).map(([caseId, stats]) => {
      const firstToken = stats.metrics.first_token_ms;
      return `<tr><td>${escapeHtml(armRun.id)}</td><td>${escapeHtml(caseId)}</td>`
        + `<td>${escapeHtml(stats.n)}</td><td>${escapeHtml(stats.throughput_rps.toFixed(2))}</td>`
        + `<td>${escapeHtml(`${(stats.error_rate * 100).toFixed(1)}%`)}</td>`
        + `<td>${escapeHtml(firstToken?.p50.toFixed(0) ?? "-")}</td>`
        + `<td>${escapeHtml(firstToken?.p95.toFixed(0) ?? "-")}</td>`
        + `<td>${escapeHtml(firstToken?.p99.toFixed(0) ?? "-")}</td></tr>`;
    });
  }).join("\n") || "<tr><td colspan=\"8\">没有带 Case ID 的请求结果</td></tr>";
  const facetRows = result.run.executions.flatMap((armRun) => {
    const window = armRun.windows.find((candidate) => candidate.id === "measurement");
    return Object.entries(window?.by_facet ?? {}).sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([facet, values]) => orderedFacetValues(result, facet, Object.keys(values)).map((value) => {
        const stats = values[value]!;
        const firstToken = stats.metrics.first_token_ms;
        return `<tr><td>${escapeHtml(armRun.id)}</td><td>${escapeHtml(facet)}</td>`
          + `<td>${escapeHtml(value)}</td><td>${escapeHtml(stats.n)}</td>`
          + `<td>${escapeHtml(stats.throughput_rps.toFixed(2))}</td>`
          + `<td>${escapeHtml(`${(stats.error_rate * 100).toFixed(1)}%`)}</td>`
          + `<td>${escapeHtml(firstToken?.p50.toFixed(0) ?? "-")}</td>`
          + `<td>${escapeHtml(firstToken?.p95.toFixed(0) ?? "-")}</td>`
          + `<td>${escapeHtml(firstToken?.p99.toFixed(0) ?? "-")}</td></tr>`;
      }));
  }).join("\n") || "<tr><td colspan=\"9\">没有带 Facet 的请求结果</td></tr>";
  const samples = result.samples.map(sampleRow).join("\n")
    || "<tr><td colspan=\"9\">未取得 Plugin 声明的可关联业务 ID</td></tr>";
  const metric = result.metric.status === CommandStatus.Ok
    ? "压测窗口 Metric 报告见顶部 metric Tab"
    : `Metric 采集未完成（${result.metric.status}）`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>doctor perf</title>
<style>body{font:14px system-ui;margin:32px;color:#17202a}table{border-collapse:collapse;width:100%;margin:16px 0 28px}th,td{border:1px solid #d9e0e6;padding:8px;text-align:left}th{background:#f4f7f9}code{font-size:12px}a{color:#075dcc}</style></head><body>
<h1>doctor perf</h1><p>run <code>${escapeHtml(result.run.run_id)}</code> · service ${escapeHtml(result.run.service)} · ${result.run.passed ? "completed" : "incomplete"} · observability evidence ${evidenceStatus}</p>
<p>${metric}</p>
<h2>负载结果</h2><table><thead><tr><th>ArmRun</th><th>并发</th><th>请求数</th><th>吞吐 req/s</th><th>错误率</th><th>首 token P50 ms</th><th>P95</th><th>P99</th><th>停止原因</th></tr></thead><tbody>${armRows}</tbody></table>
<h2>按 Case</h2><table><thead><tr><th>ArmRun</th><th>Case</th><th>请求数</th><th>吞吐 req/s</th><th>错误率</th><th>首 token P50 ms</th><th>P95</th><th>P99</th></tr></thead><tbody>${caseRows}</tbody></table>
<h2>按 Facet</h2><table><thead><tr><th>ArmRun</th><th>Facet</th><th>值</th><th>请求数</th><th>吞吐 req/s</th><th>错误率</th><th>首 token P50 ms</th><th>P95</th><th>P99</th></tr></thead><tbody>${facetRows}</tbody></table>
<h2>代表请求的 Trace / Log</h2><table><thead><tr><th>ArmRun</th><th>Case</th><th>关联键</th><th>业务 ID</th><th>首 token ms</th><th>总耗时 ms</th><th>错误</th><th>Trace</th><th>Log</th></tr></thead><tbody>${samples}</tbody></table>
<p>原始契约产物：${link(join(result.outputDir, "run.json"), "run.json")} · ${link(join(result.outputDir, "requests.jsonl"), "requests.jsonl")} · ${link(join(result.outputDir, "evaluations.json"), "evaluations.json")} · ${link(join(result.outputDir, "verdict.json"), "verdict.json")}</p>
</body></html>\n`;
  const path = join(result.outputDir, "perf.html");
  writeFileSync(path, html);
  return path;
}
