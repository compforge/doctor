import { Type, type Static, type TObject } from "typebox";
import type {
  DeepReadonlyJson,
  JsonCompatible,
  JsonObject,
} from "./json";

import type { Value, ValueCodec } from "./value";

export { Type };

/** Plugin-owned runtime Value contract; kind/version identify its JSON encoding. */
export interface ObservationDefinition<T extends Value = Value> {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly codec: ValueCodec<T>;
}

/** Existing schema-based probes remain supported while producers adopt Value codecs. */
export type ProbeObservationDefinition = ObservationDefinition | SchemaObservationDefinition;

/** A Plugin-owned, versioned contract for one kind of structured Probe result. */
export interface SchemaObservationDefinition<Schema extends TObject = TObject> {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly schema: Schema;
}

type StaticObservationValue<Definition extends ProbeObservationDefinition> =
  Definition extends SchemaObservationDefinition<infer Schema> ? Static<Schema> : never;

/** The runtime Value for a codec, or the immutable JSON payload for a schema-based probe. */
export type ObservationValue<Definition extends ProbeObservationDefinition> =
  Definition extends ObservationDefinition<infer T> ? T
  : StaticObservationValue<Definition> extends JsonObject
  ? DeepReadonlyJson<StaticObservationValue<Definition>>
  : never;

type JsonObjectSchema<Schema extends TObject> =
  [JsonCompatible<Static<Schema>>] extends [never] ? never : Schema;

/**
 * Define a versioned Observation using a Value codec, or an existing TypeBox schema.
 *
 * @spec The Codec defines the runtime Value type and validates its persisted JSON representation
 * @why TypeScript types and methods disappear during JSON persistence; decoding restores the Plugin-owned contract
 */
export function defineObservation<T extends Value>(definition: ObservationDefinition<T>): ObservationDefinition<T>;
export function defineObservation<const Schema extends TObject>(definition: {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly schema: JsonObjectSchema<Schema>;
}): SchemaObservationDefinition<Schema>;
export function defineObservation(definition: ProbeObservationDefinition): ProbeObservationDefinition {
  return definition;
}
