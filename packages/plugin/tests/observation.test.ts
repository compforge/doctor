import { withSummary } from "@compforge/doctor-plugin";
import { expect, test } from "bun:test";

import {
  defineObservation,
  defineWorkloadProbeExtension,
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
  const probe = defineWorkloadProbeExtension({
    id: "health",
    kind: "workload.probe",
    workload: "main",
    access: {},
    produces: HealthObservation,
    run: withSummary({ title: "Probe", fields: [] }, async () => ({ ready: true, details: { latencyMs: 12 } })),
  });

  expect(probe.produces).toBe(HealthObservation);
  expect((await probe.run({} as never, { facts: [], instance: {} as never })).data)
    .toEqual({ ready: true, details: { latencyMs: 12 } });
});


class CountValue {
  constructor(readonly count: number) {}
  summary() { return { title: "Count", text: String(this.count), fields: [] }; }
}
const countDefinition = defineObservation({ kind: "count", schemaVersion: 1, codec: {
  encode: (value: CountValue) => ({ count: value.count }),
  decode: (json: unknown) => {
    if (!json || typeof json !== "object" || !("count" in json) || typeof json.count !== "number") throw new Error("invalid count");
    return new CountValue(json.count);
  },
} });
type _CodecValueIsInferred = Assert<Equal<ObservationValue<typeof countDefinition>, CountValue>>;

test("Codec Probe derives the operation summary from its Value", async () => {
  const probe = defineWorkloadProbeExtension({ id: "count", kind: "workload.probe", workload: "main", access: {},
    produces: countDefinition, run: async () => new CountValue(3),
  });
  const result = await probe.run({} as never, {} as never);
  expect(result.data).toBeInstanceOf(CountValue);
  expect(result.summary).toEqual(result.data.summary());
});
