import { expect, test } from "bun:test";

import {
  defineObservation,
  defineServiceWorkloadProbe,
  Type,
  type ObservationValue,
} from "../src";

const HealthObservation = defineObservation({
  kind: "health",
  schemaVersion: 1,
  schema: Type.Object({
    ready: Type.Boolean(),
    details: Type.Object({ latencyMs: Type.Number() }, { additionalProperties: false }),
    note: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
});

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _HealthPayloadIsInferred = Assert<Equal<
  ObservationValue<typeof HealthObservation>,
  { readonly ready: boolean; readonly details: { readonly latencyMs: number }; readonly note?: string }
>>;

const nonJsonSchema = Type.Object({ count: Type.BigInt() }, { additionalProperties: false });
defineObservation({
  kind: "non-json",
  schemaVersion: 1,
  // @ts-expect-error bigint cannot cross the JSON-only Observation boundary.
  schema: nonJsonSchema,
});
const anySchema = Type.Object({ payload: Type.Any() }, { additionalProperties: false });
defineObservation({
  kind: "unconstrained",
  schemaVersion: 1,
  // @ts-expect-error any cannot bypass the JSON-only Observation boundary.
  schema: anySchema,
});

test("ObservationDefinition 是 Probe payload 的单一类型与 schema 来源", async () => {
  const probe = defineServiceWorkloadProbe({
    id: "health",
    kind: "workload",
    schemaVersion: 1,
    workload: "main",
    access: {},
    produces: HealthObservation,
    probe: async () => ({ ready: true, details: { latencyMs: 12 } }),
  });

  expect(probe.produces).toBe(HealthObservation);
  expect(await probe.probe({} as never, { facts: [], instance: {} as never }))
    .toEqual({ ready: true, details: { latencyMs: 12 } });
});
