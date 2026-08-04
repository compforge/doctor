import type { ExecResult } from "./executor";

/** Preserve the first actionable failure line without leaking transport details upstream. */
export function failReason(result: ExecResult): string {
  if (result.timedOut) return `超时（${result.durationMs}ms）`;
  return result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`;
}
