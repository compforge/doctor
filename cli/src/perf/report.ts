import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { renderPerfReport } from "@compforge/perf-harness";
import type { PerfResult } from "./model";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  const armRows = result.run.executions.map((armRun) => {
    const stats = armRun.windows.find((window) => window.kind === "phase" && window.phase === "hold")?.request;
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
    const window = armRun.windows.find((candidate) => candidate.kind === "phase" && candidate.phase === "hold");
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
    const window = armRun.windows.find((candidate) => candidate.kind === "phase" && candidate.phase === "hold");
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
  const metricIssues = result.metricIssues?.length
    ? `<h2>指标覆盖缺口</h2><ul>${result.metricIssues.map(issue => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : "";
  const sections = `${metricIssues}<h2>负载结果</h2><table><thead><tr><th>ArmRun</th><th>并发</th><th>请求数</th><th>吞吐 req/s</th><th>错误率</th><th>首 token P50 ms</th><th>P95</th><th>P99</th><th>停止原因</th></tr></thead><tbody>${armRows}</tbody></table>
<h2>按 Case</h2><table><thead><tr><th>ArmRun</th><th>Case</th><th>请求数</th><th>吞吐 req/s</th><th>错误率</th><th>首 token P50 ms</th><th>P95</th><th>P99</th></tr></thead><tbody>${caseRows}</tbody></table>
<h2>按 Facet</h2><table><thead><tr><th>ArmRun</th><th>Facet</th><th>值</th><th>请求数</th><th>吞吐 req/s</th><th>错误率</th><th>首 token P50 ms</th><th>P95</th><th>P99</th></tr></thead><tbody>${facetRows}</tbody></table>
<p>原始契约产物：run.json · requests.jsonl · evaluations.json · perf.json</p>`;
  const html = renderPerfReport(result.run).replace("<h2>Callgraph</h2>", sections + "<h2>Callgraph</h2>");
  const path = join(result.outputDir, "perf.html");
  writeFileSync(path, html);
  return path;
}
