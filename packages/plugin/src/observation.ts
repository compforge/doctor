import type { Value, ValueCodec } from "@compforge/harness-common";

/** Plugin-owned data contract for one kind of workload Observation. */
export interface ObservationDefinition<T extends Value = Value> {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly codec: ValueCodec<T>;
}

export type ObservationValue<Definition extends ObservationDefinition> =
  Definition extends ObservationDefinition<infer T> ? T : never;

export function defineObservation<T extends Value>(definition: ObservationDefinition<T>): ObservationDefinition<T> {
  return definition;
}

/** Validate the shared acquired-data declaration before invoking a Probe. */
export function validateObservationDefinition(definition: ObservationDefinition, label: string): void {
  if (!definition || typeof definition.kind !== "string" || !definition.kind.trim()
    || !Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1
    || !definition.codec || typeof definition.codec.encode !== "function" || typeof definition.codec.decode !== "function") {
    throw new Error(`${label}: invalid Observation definition`);
  }
}
