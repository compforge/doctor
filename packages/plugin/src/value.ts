import { immutableJsonObject, immutableJsonValue, type JsonInput, type JsonValue } from "./json";
import { validateSummary, type Summary } from "./summary";

/** Runtime business data and its producer-owned reading hints. */
export interface Value {
  summary(): Summary;
}

/**
 * @spec decode validates unknown JSON and restores equivalent data and behavior after encode
 * @rule Both operations are pure: no environment access or resource acquisition
 * @see ../../../cli/docs/plugin.md
 */
export interface ValueCodec<T extends Value> {
  encode(value: T): JsonInput;
  decode(json: unknown): T;
}

/** A portable representation of a Plugin-owned Value, independent of any Command or Observation. */
export interface SerializedValue {
  readonly data: JsonValue;
  readonly summary: Summary;
}

/** @spec Core normalizes absent object fields and preserves protocol data; the Codec owns domain validation and reconstruction. */
export function serializeValue<T extends Value>(value: T, codec: ValueCodec<T>, options: { label?: string; maxBytes?: number } = {}): SerializedValue {
  const label = options.label ?? "Value";
  const data = immutableJsonValue(codec.encode(value), `${label}.data`);
  if (options.maxBytes !== undefined && new TextEncoder().encode(JSON.stringify(data)).byteLength > options.maxBytes) {
    throw new Error(`${label} exceeds JSON byte budget`);
  }
  const restored = deserializeValue(data, codec);
  const summary = restored.summary();
  validateSummary(summary);
  return Object.freeze({ data, summary: immutableJsonObject(summary, `${label}.summary`) as unknown as Summary });
}

/** @spec Rehydration is explicit and pure; it never replaces a previously saved Summary. */
export function deserializeValue<T extends Value>(json: unknown, codec: ValueCodec<T>): T {
  const value = codec.decode(immutableJsonValue(json, "Value.data"));
  if (!value || typeof value.summary !== "function") throw new Error("Codec must restore a Value with summary()");
  return value;
}
