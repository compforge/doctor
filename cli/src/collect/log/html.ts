import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  escapeHtml,
  serializeInlineJson,
  writeHtmlReport,
} from "../output/html";
import type { BundleManifest } from "../output/html";
import { LOG_REPORT_SCRIPT, LOG_REPORT_STYLES } from "./html-assets";
import type { LogTimelineRecord } from "./model";

export function parseLogTimelineJsonl(text: string): LogTimelineRecord[] {
  return text.split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogTimelineRecord);
}

export function renderLogViewer(records: readonly LogTimelineRecord[]): string {
  return `<div class="log-viewer">
    <div class="log-toolbar">
      <label class="log-search-field">搜索日志
        <input type="search" class="log-search" placeholder="关键字、Service、Pod 或 Container" autocomplete="off">
      </label>
      <label>Service
        <select class="log-service-filter"></select>
      </label>
      <label>Pod
        <select class="log-pod-filter"></select>
      </label>
    </div>
    <div class="log-quick-filters" aria-label="常用关键字">
      <button type="button" class="log-quick-filter" data-query="ERROR">ERROR</button>
      <button type="button" class="log-quick-filter" data-query="WARNING">WARNING</button>
      <button type="button" class="log-quick-filter" data-query="Traceback">Traceback</button>
      <button type="button" class="log-quick-filter" data-query="Exception">Exception</button>
    </div>
    <div class="log-time-filter">
      <label>开始时间<input type="datetime-local" step="1" class="log-start-time"></label>
      <label>结束时间<input type="datetime-local" step="1" class="log-end-time"></label>
      <button type="button" class="log-reset">重置筛选</button>
    </div>
    <div class="log-histogram" aria-label="日志时间分布"></div>
    <details class="log-errors" hidden>
      <summary>采集失败 <span class="log-error-count">0</span> 项</summary>
      <pre class="log-errors-body"></pre>
    </details>
    <div class="log-result-bar">
      <span class="log-result-meta"></span>
      <button type="button" class="log-match-previous">上一处命中</button>
      <button type="button" class="log-match-next">下一处命中</button>
    </div>
    <div class="log-list" aria-live="polite"></div>
    <div class="log-controls">
      <button type="button" class="log-page-previous">上一页</button>
      <span class="log-page-info"></span>
      <button type="button" class="log-page-next">下一页</button>
    </div>
    <script type="application/json" class="log-viewer-data">${serializeInlineJson(records)}</script>
  </div>`;
}

function buildLogSummary(manifest: BundleManifest, records: readonly LogTimelineRecord[]): string {
  const target = manifest.target ?? {};
  const params = manifest.params ?? {};
  const logCount = records.filter((record) => record.kind === "log").length;
  const errorCount = records.length - logCount;
  const services = Array.isArray(target.services) ? target.services.join(", ") : String(target.services ?? "");
  const timeWindow = params.since_time
    ? `since-time=${String(params.since_time)}`
    : `since=${String(params.since ?? "")}`;
  return `<h1>日志诊断</h1>
    <p>按时间聚合多个 Service 的业务日志，支持离线搜索、时间范围和来源筛选。</p>
    <ul>
      <li>Namespace：<code>${escapeHtml(target.namespace ?? "")}</code></li>
      <li>Biz ID：<code>${escapeHtml(target.biz_id ?? "")}</code></li>
      <li>Trace IDs：<code>${escapeHtml(Array.isArray(target.trace_ids) ? target.trace_ids.join(", ") : target.trace_id ?? "")}</code></li>
      <li>Services：${escapeHtml(services)}</li>
      <li>时间窗口：<code>${escapeHtml(timeWindow)}</code></li>
      <li>日志事件：${logCount} 条；采集失败：${errorCount} 项</li>
    </ul>`;
}

/** 从 Bundle 内的结构化时间线生成无外部依赖、可直接双击打开的报告。 */
export function writeLogHtmlReport(bundleDir: string, outputPath: string, profileName: string): void {
  const records = parseLogTimelineJsonl(readFileSync(join(bundleDir, "timeline.jsonl"), "utf-8"));
  const manifest = JSON.parse(
    readFileSync(join(bundleDir, "manifest.json"), "utf-8"),
  ) as BundleManifest;
  writeHtmlReport(bundleDir, outputPath, {
    title: "doctor log 日志报告",
    profileName,
    summaryHtml: buildLogSummary(manifest, records),
    sections: [{ id: "log-timeline", title: "日志时间线", html: renderLogViewer(records) }],
    assets: { styles: LOG_REPORT_STYLES, script: LOG_REPORT_SCRIPT },
  });
}
