import { batchIterator } from "@compforge/ts-stdx/iter";
import { gzipSync } from "node:zlib";
import zipSource from "../../../node_modules/fflate/umd/index.js" with { type: "text" };
import { readTimeline } from "./timeline-file";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml, writeHtmlReport } from "../output/html";
import type { CollectionRecord } from "../output/html";
import { LOG_REPORT_SCRIPT, LOG_REPORT_STYLES } from "./html-assets";
import { formatLogCaptureStats } from "./render";
import type { LogKey } from "./correlation";
import type { LogRenderStats, LogTimelineRecord } from "./model";

function renderLogViewer(chunks: readonly string[]): string {
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
    ${chunks.join("")}
  </div>`;
}

function buildLogSummary(manifest: CollectionRecord, logCount: number, errorCount: number, stats?: LogRenderStats): string {
  const target = manifest.target ?? {};
  const params = manifest.params ?? {};
  const services = Array.isArray(target.services) ? target.services.join(", ") : String(target.services ?? "");
  const keys = Array.isArray(target.keys)
    ? (target.keys as LogKey[]).map(key => `${key.kind}:${key.identity.kind}=${key.identity.value}${key.service ? ` (${key.service})` : ""}`).join(", ")
    : (Array.isArray(target.trace_ids) ? target.trace_ids.join(", ") : String(target.trace_id ?? ""));
  const timeWindow = params.since_time
    ? `since-time=${String(params.since_time)}`
    : `since=${String(params.since ?? "")}`;
  return `<h1>日志诊断</h1>
    <p>按时间聚合多个 Service 的业务日志，支持离线搜索、时间范围和来源筛选。</p>
    ${stats ? `<p>${escapeHtml(formatLogCaptureStats(stats, target.mode === "service"))}</p>` : ""}
    <ul>
      <li>Namespace：<code>${escapeHtml(target.namespace ?? "")}</code></li>
      ${target.mode === "service" ? "<li>模式：Service / 时间范围（不按业务 ID 过滤）</li>" : `<li>Biz ID：<code>${escapeHtml(target.biz_id ?? "")}</code></li>
      <li>匹配 keys：<code>${escapeHtml(keys)}</code></li>`}
      <li>Services：${escapeHtml(services)}</li>
      <li>时间窗口：<code>${escapeHtml(`${timeWindow}${params.until_time ? ` until-time=${params.until_time}（含边界）` : ""}`)}</code></li>
      <li>日志事件：${logCount} 条；采集失败：${errorCount} 项</li>
    </ul>`;
}

function encodeChunk(values: readonly unknown[]): string {
  return gzipSync(JSON.stringify(values), { level: 1 }).toString("base64");
}

/** 从 Bundle 内的结构化时间线生成无外部依赖、可直接双击打开的报告。 */
export async function writeLogHtmlReport(bundleDir: string, outputPath: string, profileName: string,
  evidenceDir = ".", failureReason?: string): Promise<void> {
  if (!existsSync(join(bundleDir, "timeline.jsonl"))) {
    const errorFile = join(bundleDir, "error.log");
    const reason = failureReason ?? (existsSync(errorFile)
      ? readFileSync(errorFile, "utf8").match(/^reason=(.+)$/m)?.[1] : undefined);
    if (!reason) throw new Error("日志时间线缺失：timeline.jsonl");
    const raw = join(bundleDir, "raw");
    const count = existsSync(raw) ? readdirSync(raw, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".log")).length : 0;
    writeFileSync(outputPath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>日志诊断</title>
      <h1>日志时间线未生成</h1><p>${escapeHtml(reason)}</p>
      <p>已保留 ${count} 份原始日志${count ? `，解压后见 <code>${escapeHtml(join(evidenceDir, "raw"))}/</code>` : ""}。</p></html>`,
      { mode: 0o600 });
    return;
  }

  // Metadata drives ordering, navigation and filters; message chunks inflate on demand in the viewer.
  const chunks: string[] = [];
  let logCount = 0;
  let errorCount = 0;
  for await (const batch of batchIterator(readTimeline(bundleDir), 512)) {
    const metadata: Omit<LogTimelineRecord, "message">[] = [];
    const messages: string[] = [];
    let messageBytes = 0;
    function flush() {
      chunks.push(`<template class="log-chunk" data-index="${encodeChunk(metadata)}">${encodeChunk(messages)}</template>`);
      metadata.length = 0;
      messages.length = 0;
      messageBytes = 0;
    }
    for (const { message, ...record } of batch) {
      const bytes = Buffer.byteLength(message);
      if (messages.length && messageBytes + bytes > 512 * 1024) flush();
      messageBytes += bytes;
      metadata.push(record);
      messages.push(message);
      if (record.kind === "log") logCount++;
      else errorCount++;
    }
    flush();
  }
  const manifest = JSON.parse(
    readFileSync(join(bundleDir, "collection.json"), "utf-8"),
  ) as CollectionRecord;
  const statsPath = join(bundleDir, "log-stats.json");
  const stats = existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, "utf-8")) as LogRenderStats : undefined;
  writeHtmlReport(bundleDir, outputPath, {
    title: "doctor log 日志报告",
    profileName,
    summaryHtml: buildLogSummary(manifest, logCount, errorCount, stats),
    sections: [{ id: "log-timeline", title: "日志时间线", html: renderLogViewer(chunks) }],
    assets: { styles: LOG_REPORT_STYLES, script: zipSource + "\n" + LOG_REPORT_SCRIPT },
  });
}
