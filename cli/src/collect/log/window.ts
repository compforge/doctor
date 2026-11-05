import { parseDuration } from "@compforge/harness-toolbox/duration";
import { CommandInputError } from "../../command";
import type { DataLogWindow, DataLogWindows, DataWindowRejection } from "./data-window";
import type { TraceOutput } from "../trace";
import { readTraceSnapshot } from "../trace/snapshot";
import type { TimeWindowOptions } from "../time-window";
import { useLogger } from "../../terminal/log";
import { resolveLogTimeWindow } from "./config";

export interface TraceLogWindow {
  readonly bizId: string;
  readonly traceId: string;
  readonly startMs: number;
  readonly endMs: number;
}

export const DEFAULT_TIME_PADDING = "10m";

export function timePaddingMs(value = DEFAULT_TIME_PADDING): number {
  try { return parseDuration(value); }
  catch { throw new CommandInputError(`time-padding 必须是正时长，例如 10m：${value}`); }
}

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

export interface AppliedLogWindow {
  source: "data" | "trace";
  contribution?: DataLogWindow;
  traceIds?: readonly string[];
  from: string;
  to: string;
  fromSource: "data" | "trace" | "lookback";
  toSource: "data" | "trace" | "collection-start";
  timePadding: string;
  paddingSource: "cli" | "contribution" | "profile" | "default";
}

export interface LogTimeWindow extends TimeWindowOptions {
  source: "explicit" | "data" | "trace" | "default";
  windows: readonly AppliedLogWindow[];
  rejected: readonly DataWindowRejection[];
  fallbackReason?: string;
}

/**
 * @spec Explicit ranges win; otherwise pad each business window before union, then fall back to complete traces or existing policy.
 * @rule A missing bound is filled independently. Conflicting or unrepresentable intervals are rejected, never swapped.
 * @see {@link ../../../docs/commands/log-diagnosis.md}
 */
export function selectLogTimeWindow(input: TimeWindowOptions & {
  id?: string; traceIds: readonly string[]; traceWindows?: readonly TraceLogWindow[];
  dataWindows?: DataLogWindows; timePadding?: string; profileTimePadding?: string; now?: Date;
}): LogTimeWindow {
  // Explicit configuration errors must fail rather than select a lower-priority value.
  timePaddingMs(input.timePadding ?? input.profileTimePadding);
  const explicit = input.since !== undefined || input.sinceTime !== undefined || input.untilTime !== undefined;
  if (explicit) return { ...resolveLogTimeWindow(input), untilTime: input.untilTime, source: "explicit", windows: [], rejected: [] };
  const rejected = [...(input.dataWindows?.rejected.filter(item => item.bizId === input.id) ?? [])];
  const traces = input.traceIds.map(traceId => input.traceWindows?.find(window => window.bizId === input.id && window.traceId === traceId));
  const trace = traces.length && traces.every(window => window !== undefined)
    ? { startMs: Math.min(...traces.map(window => window.startMs)), endMs: Math.max(...traces.map(window => window.endMs)) } : undefined;
  const padding = (contribution?: DataLogWindow): Pick<AppliedLogWindow, "timePadding" | "paddingSource"> => {
    if (input.timePadding !== undefined) return { timePadding: input.timePadding, paddingSource: "cli" };
    if (contribution?.window.timePadding !== undefined) return { timePadding: contribution.window.timePadding, paddingSource: "contribution" };
    if (input.profileTimePadding !== undefined) return { timePadding: input.profileTimePadding, paddingSource: "profile" };
    return { timePadding: DEFAULT_TIME_PADDING, paddingSource: "default" };
  };
  const windows: AppliedLogWindow[] = [];
  let startMs = Infinity, endMs = -Infinity;
  const add = (window: AppliedLogWindow): boolean => {
    const from = Date.parse(window.from), to = Date.parse(window.to), margin = timePaddingMs(window.timePadding);
    if (from > to || !Number.isFinite(new Date(from - margin).getTime()) || !Number.isFinite(new Date(to + margin).getTime())) return false;
    startMs = Math.min(startMs, from - margin);
    endMs = Math.max(endMs, to + margin);
    windows.push(window);
    return true;
  };
  for (const contribution of input.dataWindows?.windows ?? []) {
    if (contribution.bizId !== input.id || contribution.window.identity.value !== input.id) continue;
    const { window } = contribution;
    const to = window.to ?? (trace ? new Date(trace.endMs).toISOString() : (input.now ?? new Date()).toISOString());
    const from = window.from ?? (trace ? new Date(trace.startMs).toISOString() : resolveLogTimeWindow({ untilTime: to }).sinceTime!);
    if (!add({ source: "data", contribution, from, to,
      ...(trace && (window.from === undefined || window.to === undefined) ? { traceIds: input.traceIds } : {}),
      fromSource: window.from !== undefined ? "data" : trace ? "trace" : "lookback",
      toSource: window.to !== undefined ? "data" : trace ? "trace" : "collection-start",
      ...padding(contribution),
    })) rejected.push({ bizId: contribution.bizId, service: contribution.service, queryId: contribution.queryId,
      factIndex: contribution.factIndex, reason: "补齐或 padding 后的窗口冲突或超出可表示范围" });
  }
  if (!windows.length && trace) add({ source: "trace", traceIds: input.traceIds,
    from: new Date(trace.startMs).toISOString(), to: new Date(trace.endMs).toISOString(),
    fromSource: "trace", toSource: "trace", ...padding(),
  });
  if (windows.length) return { source: windows[0]!.source, sinceTime: new Date(startMs).toISOString(),
    untilTime: new Date(endMs).toISOString(), windows, rejected };
  return { ...resolveLogTimeWindow(input), source: "default", windows, rejected,
    fallbackReason: input.id === undefined ? undefined : input.traceIds.length ? "没有可用的完整 Trace 时间范围或窗口超出可表示范围，沿用原有日志窗口" : "无可用 Data 窗口，沿用原有日志窗口",
  };
}
