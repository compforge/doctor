import { Type, type Static, type TObject } from "typebox";
import type {
  DeepReadonlyJson,
  JsonCompatible,
  JsonObject,
} from "./json";
import type { ServiceWorkloadProbe } from "./service";

export { Type };

/** A Plugin-owned, versioned contract for one kind of structured Probe result. */
export interface ObservationDefinition<Schema extends TObject = TObject> {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly schema: Schema;
}

type StaticObservationValue<Definition extends ObservationDefinition> =
  Static<Definition["schema"]>;

/** The deeply read-only payload inferred from an ObservationDefinition's JSON Schema. */
export type ObservationValue<Definition extends ObservationDefinition> =
  StaticObservationValue<Definition> extends JsonObject
    ? DeepReadonlyJson<StaticObservationValue<Definition>>
    : never;

type JsonObjectSchema<Schema extends TObject> =
  [JsonCompatible<Static<Schema>>] extends [never] ? never : Schema;

/**
 * Define one Observation contract from a TypeBox object schema.
 *
 * @spec Observation payload types are inferred from the same JSON Schema that Core validates at runtime
 * @why TypeScript types disappear at the dynamic ESM Plugin boundary, while JSON Schema remains portable Evidence metadata
 */
export function defineObservation<const Schema extends TObject>(definition: {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly schema: JsonObjectSchema<Schema>;
}): ObservationDefinition<Schema> {
  return definition;
}

/** Preserve the ObservationDefinition-to-payload relationship while authoring a workload Probe. */
export function defineServiceWorkloadProbe<const Definition extends ObservationDefinition>(
  probe: ServiceWorkloadProbe<Definition>,
): ServiceWorkloadProbe<Definition> {
  return probe;
}
