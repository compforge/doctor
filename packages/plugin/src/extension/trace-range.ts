import type { Extension, RegisteredExtension } from "./index";
import type { ServiceTraceIdResolution } from "../service";

export const TRACE_RANGE_KIND = "trace.range";

export interface TraceRangeInput {
  window: { from: string; to: string };
  /** Maximum number of trace IDs returned by one provider call. */
  limit: number;
}

export interface TraceRangeResult {
  items: readonly ServiceTraceIdResolution[];
  truncated?: { reason: string };
}

export interface TraceRangeExtension extends Extension<TraceRangeInput, TraceRangeResult> {
  readonly kind: typeof TRACE_RANGE_KIND;
}

export function requireTraceRangeExtension(extension: RegisteredExtension): TraceRangeExtension {
  if (extension.kind !== TRACE_RANGE_KIND) throw new Error(`Expected ${TRACE_RANGE_KIND}, got ${extension.kind}`);
  return extension as TraceRangeExtension;
}

export function traceRangeOutput(value: unknown, limit: number): TraceRangeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("trace.range returned an invalid result");
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.items) || result.items.length > limit) throw new Error("trace.range exceeded its trace limit");
  for (const item of result.items) {
    if (!item || typeof item !== "object" || typeof item.traceId !== "string" || !item.traceId.trim()
      || typeof item.resolvedAs !== "string" || !item.resolvedAs.trim()
      || (item.sourceId !== undefined && typeof item.sourceId !== "string")) {
      throw new Error("trace.range returned an invalid trace resolution");
    }
  }
  if (result.truncated !== undefined && (!result.truncated || typeof result.truncated !== "object"
    || typeof (result.truncated as Record<string, unknown>).reason !== "string"
    || !(result.truncated as Record<string, unknown>).reason)) {
    throw new Error("trace.range returned an invalid truncation reason");
  }
  return result as unknown as TraceRangeResult;
}
