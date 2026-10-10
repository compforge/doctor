import { parseDuration } from "@compforge/harness-toolbox/duration";
import { logTimestampNanos } from "@compforge/harness-toolbox/kubernetes/log-timestamp";
import type { InspectTimeWindow } from "@compforge/doctor-plugin";
import { CommandInputError } from "../command";

export interface TimeWindowOptions {
  since?: string;
  sinceTime?: string;
  untilTime?: string;
}

/**
 * @spec Explicit windows use inclusive bounds; since-time takes precedence over since.
 * @why Freeze relative time before preparation so composed collectors inspect the same interval.
 * Missing options preserve collector-owned default policies.
 */
export function resolveTimeWindow(input: TimeWindowOptions, now = new Date()): InspectTimeWindow | undefined {
  if (input.since === undefined && input.sinceTime === undefined && input.untilTime === undefined) return undefined;
  const timestamp = (value: string, option: string): bigint => {
    const nanos = logTimestampNanos(value);
    if (nanos === undefined || !Number.isFinite(Date.parse(value))) throw new CommandInputError(`${option} 必须是 RFC3339 时间戳`);
    return nanos;
  };
  const to = input.untilTime ?? now.toISOString();
  const end = timestamp(to, "--until-time");
  let from = input.sinceTime;
  if (from === undefined && input.since !== undefined) {
    let duration: number;
    try { duration = parseDuration(input.since); }
    catch (error) { throw new CommandInputError(`--since: ${error instanceof Error ? error.message : String(error)}`); }
    const start = new Date(Date.parse(to) - duration);
    if (!Number.isFinite(start.getTime())) throw new CommandInputError("--since 超出可表示范围");
    from = start.toISOString();
  }
  if (from !== undefined && timestamp(from, "--since-time") > end) throw new CommandInputError("--until-time 不能早于 --since-time");
  return { ...(from !== undefined ? { from } : {}), to };
}

export function freezeTimeWindow<T extends TimeWindowOptions>(input: T, now = new Date()): Omit<T, keyof TimeWindowOptions> & TimeWindowOptions {
  const window = resolveTimeWindow(input, now);
  return window ? { ...input, since: undefined, sinceTime: window.from, untilTime: window.to } : input;
}
