/** Values that can cross the Plugin boundary without lossy JavaScript-to-JSON conversion. */
export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | JsonObject;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

type IsAny<Value> = 0 extends (1 & Value) ? true : false;
type JsonPropertyValue<Value extends object, Key extends keyof Value> =
  {} extends Pick<Value, Key> ? Exclude<Value[Key], undefined> : Value[Key];
type IsJsonCompatible<Value> =
  IsAny<Value> extends true ? false
    : [Value] extends [JsonPrimitive] ? true
    : Value extends (...args: never[]) => unknown ? false
    : [Value] extends [readonly unknown[]] ? IsJsonCompatible<Value[number]>
    : [Value] extends [object] ? (
      false extends {
        [Key in keyof Value]-?: IsJsonCompatible<JsonPropertyValue<Value, Key>>
      }[keyof Value] ? false : true
    )
    : false;

/** Keep a concrete value type only when every reachable value is lossless JSON. */
export type JsonCompatible<Value> =
  IsJsonCompatible<Value> extends true ? Value : never;

/** The immutable view Core exposes after it has validated and snapshotted a JSON value. */
export type DeepReadonlyJson<Value> =
  Value extends JsonPrimitive ? Value
    : Value extends readonly (infer Item)[] ? readonly DeepReadonlyJson<Item>[]
    : Value extends JsonObject ? { readonly [Key in keyof Value]: DeepReadonlyJson<Value[Key]> }
    : never;
