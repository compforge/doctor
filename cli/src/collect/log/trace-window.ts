import type { TraceOutput } from "../trace";
import { readTraceSnapshot } from "../trace/snapshot";
import { useLogger } from "../../terminal/log";
import type { TraceLogWindow } from "./window";

/** @rule Only complete, whole-trace evidence can narrow a default log window. No remote reads. */
export function traceLogWindows(output: TraceOutput | undefined): TraceLogWindow[] {
  const windows: TraceLogWindow[] = [];
  for (const item of output?.items ?? []) {
    for (const artifact of item.artifacts) {
      try {
        const snapshot = readTraceSnapshot(artifact.path);
        if (snapshot.collection.scope !== "trace" || !snapshot.collection.complete || !snapshot.spans.length) continue;
        if (!item.traceIds.includes(snapshot.trace_id)) continue;
        const valid = snapshot.spans.every(span => Number.isFinite(span.start_ms)
          && Number.isFinite(span.dur_ms) && span.dur_ms >= 0 && Number.isFinite(span.start_ms + span.dur_ms));
        if (!valid) continue;
        let startMs = Infinity, endMs = -Infinity;
        for (const span of snapshot.spans) {
          startMs = Math.min(startMs, span.start_ms);
          endMs = Math.max(endMs, span.start_ms + span.dur_ms);
        }
        if (!Number.isFinite(new Date(startMs).getTime())
          || !Number.isFinite(new Date(endMs).getTime())) continue;
        windows.push({ bizId: item.bizId, traceId: snapshot.trace_id, startMs, endMs });
      } catch (error) {
        useLogger("collect:log").warn(`无法读取 ${item.bizId} 的 Trace 时间范围，将保留原日志窗口：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return windows;
}
