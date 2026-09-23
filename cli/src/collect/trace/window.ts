import { parseDuration } from "@compforge/harness-toolbox/duration";
import { logTimestampNanos } from "@compforge/harness-toolbox/kubernetes/log-timestamp";

export interface TraceWindowInput {
  since?: string;
  sinceTime?: string;
  untilTime?: string;
}

/** Freeze relative time once, before the Plugin queries business records. */
export function resolveTraceWindow(input: TraceWindowInput, now = new Date()): { from: string; to: string } {
  if (!input.since && !input.sinceTime) throw new Error("时间范围需要 --since 或 --since-time");
  const to = input.untilTime ?? now.toISOString();
  if (logTimestampNanos(to) === undefined) throw new Error("--until-time 必须是 RFC3339 时间戳");
  const toMs = Date.parse(to);
  if (!Number.isFinite(toMs)) throw new Error("--until-time 超出可表示范围");
  let from: string;
  if (input.sinceTime) {
    if (logTimestampNanos(input.sinceTime) === undefined) throw new Error("--since-time 必须是 RFC3339 时间戳");
    from = input.sinceTime;
  } else {
    const duration = parseDuration(input.since!);
    from = new Date(toMs - duration).toISOString();
  }
  if (Date.parse(from) >= toMs) throw new Error("时间范围起点必须早于终点");
  return { from, to };
}
