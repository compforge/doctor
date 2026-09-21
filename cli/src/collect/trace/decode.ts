/**
 * Trace payload offload marker decoding.
 *
 * Producer: byted_volc_app_common.tracing.trace_dump (Python) writes span attributes with
 * compacted payloads. Large string leaves are replaced by one of three markers:
 *
 *   - `[trace zstd {size}B {base64(zstd(utf8))}]`  — self-contained lossless compression
 *   - `[trace ref sha256:{sha16} {size}B]`         — run-scoped dedup reference (not handled here:
 *     the target lives in another span of the same run; resolving needs the full trace)
 *   - `[trace omitted {size}B]`                     — lossy middle truncation (not recoverable)
 *
 * This module decodes only the self-contained zstd marker, leaving ref/omitted markers untouched.
 * The marker may appear as a whole string value, or nested inside a JSON string value
 * (e.g. `{"command": "[trace zstd …]"}` in gen_ai.tool.call.arguments).
 *
 * The format is pinned by common's TRACE_DUMP_ZSTD_FORMAT / _TRACE_ZSTD_RE; keep the regex and
 * codec (base64 + zstd, UTF-8) in lockstep with byted_volc_app_common/tracing/trace_dump.py.
 */

import { decompress } from "fzstd";

const ZSTD_MARKER = /^\[trace zstd (?<size>\d+)B (?<data>[A-Za-z0-9+/=]+)\]$/;

const textDecoder = new TextDecoder();

/** Decode a single zstd marker to its original string. Returns null when not a marker or decode fails. */
function decodeMarker(marker: string): string | null {
  const match = ZSTD_MARKER.exec(marker.trim());
  if (!match?.groups) return null;
  try {
    const compressed = Buffer.from(match.groups.data, "base64");
    return textDecoder.decode(decompress(compressed));
  } catch {
    return null; // corrupt payload or codec mismatch: keep the marker, do not throw
  }
}

/**
 * Decode zstd markers inside a string value. Handles two shapes:
 *   1. the whole string is a marker → decoded string
 *   2. the string is JSON whose leaf string values contain markers → JSON with leaves decoded
 * Non-marker strings and unparseable JSON pass through unchanged.
 */
export function decodeTracePayload(value: string): string {
  const whole = decodeMarker(value);
  if (whole !== null) return whole;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return value; // not JSON: nothing to decode
  }
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const decoded = decodeMarker(v);
      if (decoded !== null) { changed = true; return decoded; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  const result = walk(parsed);
  return changed ? JSON.stringify(result) : value;
}

/**
 * Decode zstd markers in a raw Jaeger span record (the `_source` shape written to spans.jsonl).
 * Covers tags[].value and logs[].fields[].value — the two places gen_ai.* payload attributes live.
 * Returns a new object; the input span is never mutated.
 */
export function decodeSpanPayloads(span: Record<string, unknown>): Record<string, unknown> {
  const decodeTags = (tags: unknown): unknown => {
    if (!Array.isArray(tags)) return tags;
    return tags.map((tag) => {
      if (tag && typeof tag === "object" && typeof (tag as { value?: unknown }).value === "string") {
        const decoded = decodeTracePayload((tag as { value: string }).value);
        return decoded === (tag as { value: string }).value ? tag : { ...(tag as object), value: decoded };
      }
      return tag;
    });
  };
  const decodeLogs = (logs: unknown): unknown => {
    if (!Array.isArray(logs)) return logs;
    return logs.map((log) => {
      if (log && typeof log === "object" && "fields" in log) {
        return { ...(log as object), fields: decodeTags((log as { fields?: unknown }).fields) };
      }
      return log;
    });
  };
  return { ...span, tags: decodeTags(span.tags), logs: decodeLogs(span.logs) };
}
