import type { JsonObject } from "./json";
import type { Summary } from "./summary";

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
  encode(value: T): JsonObject;
  decode(json: unknown): T;
}
