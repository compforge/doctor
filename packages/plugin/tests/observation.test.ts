import { expect, test } from "bun:test";
import { defineObservation, defineWorkloadProbeExtension, type ObservationValue } from "../src";
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
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
    produces: countDefinition, run: async () => ({ value: new CountValue(3), status: "ok" }),
  });
  const result = await probe.run({} as never, {} as never);
  expect(result.data.value).toBeInstanceOf(CountValue);
  expect(result.summary).toEqual(result.data.value.summary());
});


test("portable value runtime exports belong to common rather than the Plugin SDK", async () => {
  const sdk = await import("../src");
  const common = await import("@compforge/harness-common");
  for (const name of ["serializeValue", "deserializeValue", "immutableJsonValue", "immutableJsonObject", "validateSummary"] as const) {
    expect(common[name]).toBeFunction();
    expect(sdk).not.toHaveProperty(name);
  }
});
