import type { CaseModelType } from "@compforge/doctor-plugin";

export interface CaseModelResult { errors: string[] }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** @spec A successful HTTP status is insufficient: functional model probes require a usable protocol result, not answer-quality scoring. */
export function inspectCaseModel(text: string, type: CaseModelType): CaseModelResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return { errors: ["Model response is not valid JSON"] }; }
  const payload = record(value);
  if (!payload) return { errors: ["Model response must be a JSON object"] };
  // Do not copy provider messages here: bounded, redacted raw evidence already preserves them.
  if (payload.error !== undefined && payload.error !== null) return { errors: ["Model response contains an error"] };
  if (type === "llm") {
    const valid = Array.isArray(payload.choices) && payload.choices.length > 0 && payload.choices.every(choice => {
      const message = record(record(choice)?.message);
      return message?.role === "assistant" && typeof message.content === "string" && message.content.trim().length > 0;
    });
    return { errors: valid ? [] : ["Model response has no valid assistant completion"] };
  }
  if (type === "embedding") {
    const valid = Array.isArray(payload.data) && payload.data.length > 0 && payload.data.every(item => {
      const vector = record(item)?.embedding;
      return Array.isArray(vector) && vector.length > 0 && vector.every(number => typeof number === "number" && Number.isFinite(number));
    });
    return { errors: valid ? [] : ["Model response has no valid embedding vector"] };
  }
  const valid = Array.isArray(payload.results) && payload.results.length > 0 && payload.results.every(item => {
    const result = record(item);
    return result && Number.isInteger(result.index) && (result.index as number) >= 0
      && typeof result.relevance_score === "number" && Number.isFinite(result.relevance_score);
  });
  return { errors: valid ? [] : ["Model response has no valid rerank results"] };
}
