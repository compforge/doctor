import { parseDuration } from "@compforge/harness-toolbox/duration";
import { logTimestampNanos } from "@compforge/harness-toolbox/kubernetes/log-timestamp";
import type { Identity, RecordFact } from "./capability";

export const COLLECT_WINDOW_KIND = "collect.window";

/**
 * @spec Business-owned collection bounds for exactly one Identity; at least one bound is required.
 * @why A related object's lifetime does not automatically describe the requested activity.
 * @see {@link ../../../cli/docs/commands/log-diagnosis.md}
 */
export interface CollectWindow {
  identity: Identity;
  /** Inclusive RFC3339 bounds. Missing bounds are unknown, not unbounded. */
  from?: string;
  to?: string;
  /** Suggested positive duration on each side; explicit caller padding takes precedence. */
  timePadding?: string;
}

export interface CollectWindowFact extends RecordFact<CollectWindow> {
  kind: typeof COLLECT_WINDOW_KIND;
  schemaVersion: 1;
}

/** Validate the standardized payload without interpreting other domain records. */
export function validateCollectWindow(value: unknown): CollectWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("collect.window must be an object");
  const window = value as Record<string, unknown>;
  const identity = window.identity as Partial<Identity> | undefined;
  if (!identity || typeof identity.kind !== "string" || !identity.kind.trim()
    || typeof identity.value !== "string" || !identity.value.trim()) throw new Error("collect.window.identity requires kind and value");
  if (window.from === undefined && window.to === undefined) throw new Error("collect.window requires from or to");
  for (const field of ["from", "to"] as const) {
    const bound = window[field];
    if (bound !== undefined && (typeof bound !== "string" || logTimestampNanos(bound) === undefined
      || !Number.isFinite(Date.parse(bound)))) throw new Error(`collect.window.${field} must be an RFC3339 timestamp`);
  }
  if (window.from !== undefined && window.to !== undefined
    && logTimestampNanos(window.from as string)! > logTimestampNanos(window.to as string)!) {
    throw new Error("collect.window.from must not be after to");
  }
  if (window.timePadding !== undefined) {
    if (typeof window.timePadding !== "string") throw new Error("collect.window.timePadding must be a positive duration");
    try { parseDuration(window.timePadding); }
    catch { throw new Error("collect.window.timePadding must be a positive duration"); }
  }
  return { identity: { kind: identity.kind, value: identity.value },
    ...(window.from !== undefined ? { from: window.from as string } : {}),
    ...(window.to !== undefined ? { to: window.to as string } : {}),
    ...(window.timePadding !== undefined ? { timePadding: window.timePadding as string } : {}),
  };
}
