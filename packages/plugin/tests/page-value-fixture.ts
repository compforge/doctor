import { immutableJsonObject, type JsonObject, type Value, type ValueCodec } from "@compforge/harness-common";
export class PageValue implements Value {
  constructor(readonly data: JsonObject) {}
  summary() { return { title: "Record", fields: [] }; }
}
export const pageCodec: ValueCodec<PageValue> = {
  encode: value => value.data,
  decode: json => new PageValue(immutableJsonObject(json, "Record")),
};
