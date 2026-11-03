import type { Value, ValueCodec } from "./value";

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
