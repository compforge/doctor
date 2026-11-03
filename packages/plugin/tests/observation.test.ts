import { expect, test } from "bun:test";
import { defineObservation, defineWorkloadProbeExtension, serializeValue, deserializeValue, type JsonValue, type ObservationValue } from "../src";
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
    produces: countDefinition, run: async () => new CountValue(3),
  });
  const result = await probe.run({} as never, {} as never);
  expect(result.data).toBeInstanceOf(CountValue);
  expect(result.summary).toEqual(result.data.summary());
});

/** @case A Value can encode a root array with nested compounds, without a Command or Probe registration. */
test("Value persistence accepts compound JSON and restores behavior explicitly", () => {
  class Tree {
    constructor(readonly nodes: JsonValue) {}
    summary() { return { title: "Tree", fields: [] }; }
  }
  const codec = { encode: (tree: Tree) => tree.nodes, decode: (json: unknown) => new Tree(json as JsonValue) };
  const saved = serializeValue(new Tree([{ children: [1, true, null], settings: { key: "value" } }]), codec);
  expect(saved.data).toEqual([{ children: [1, true, null], settings: { key: "value" } }]);
  expect(Object.isFrozen(saved.data)).toBe(true);
  expect(deserializeValue(JSON.parse(JSON.stringify(saved.data)), codec)).toBeInstanceOf(Tree);
  expect(() => serializeValue(new Tree(saved.data), codec, { maxBytes: 1 })).toThrow("byte budget");
  expect(() => serializeValue(new Tree([undefined] as never), codec)).toThrow("unsupported JSON value");
});

/** @case Codec validation sees normalized data and still owns required-field validation. */
test("Value serialization normalizes optional fields before decode and measures the saved data", () => {
  class Label {
    constructor(readonly name: string, readonly note?: string) {}
    summary() { return { title: this.name, text: this.note, fields: [] }; }
  }
  const codec = {
    encode: (value: Label) => ({ name: value.name, note: value.note }),
    decode: (json: unknown) => {
      if (!json || typeof json !== "object" || !("name" in json) || typeof json.name !== "string") throw new Error("name is required");
      expect(Object.hasOwn(json, "note")).toBe(false);
      return new Label(json.name);
    },
  };
  const saved = serializeValue(new Label("Example"), codec, { maxBytes: JSON.stringify({ name: "Example" }).length });
  expect(saved.data).toEqual({ name: "Example" });
  expect(saved.summary).toEqual({ title: "Example", fields: [] });
  expect(Object.hasOwn(saved.summary, "text")).toBe(false);
  expect(deserializeValue(JSON.parse(JSON.stringify(saved.data)), codec)).toBeInstanceOf(Label);
  expect(() => serializeValue(new Label("Example"), { ...codec, encode: () => ({ name: undefined }) })).toThrow("name is required");
});
