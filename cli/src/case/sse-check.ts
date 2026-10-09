import type { CaseSseExpectation } from "@compforge/doctor-plugin";
import { parseSseCapture } from "../collect/shared/http/sse";

export interface CaseSseResult {
  events: Record<string, number>;
  errors: string[];
}

/** The producer declares protocol event names; Core only evaluates the captured stream. */
export function inspectCaseSse(text: string, expect: CaseSseExpectation, secrets: readonly string[]): CaseSseResult {
  const result: CaseSseResult = { events: Object.create(null), errors: [] };
  const capture = parseSseCapture(text);
  for (const frame of capture.events) {
    if (!frame.data.trim() || frame.data.trim() === "[DONE]") continue;
    let value: unknown;
    try { value = JSON.parse(frame.data); }
    catch { result.errors.push(`SSE frame ${frame.index}: invalid JSON`); continue; }
    const payload = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const event = payload?.[expect.eventField];
    if (typeof event !== "string") {
      result.errors.push(`SSE frame ${frame.index}: missing ${expect.eventField}`);
      continue;
    }
    result.events[event] = (result.events[event] ?? 0) + 1;
    if (expect.errorEvents.includes(event)) {
      // Keep a bounded diagnostic from the actual error frame, including protocol-specific error details.
      let detail = frame.data;
      for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) detail = detail.replaceAll(secret, "[redacted]");
      result.errors.push(`SSE frame ${frame.index}: ${detail.slice(0, 2048)}`);
    }
  }
  if (capture.trailingBytes) result.errors.push("SSE stream ended with an incomplete frame");
  if (!result.events[expect.terminalEvent]) result.errors.push(`Missing terminal event: ${expect.terminalEvent}`);
  if (!expect.requiredEvents.some(event => result.events[event])) result.errors.push(`Missing response event: ${expect.requiredEvents.join(" / ")}`);
  return result;
}
