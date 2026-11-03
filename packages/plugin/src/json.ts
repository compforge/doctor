/** Normalized protocol data: object absence is represented by an omitted property. */
export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | JsonObject;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

/** Encoder input may express absent object fields as undefined; array elements must have a value. */
export type JsonInput = JsonPrimitive | readonly JsonInput[] | { readonly [key: string]: JsonInput | undefined };

function propertyPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

function cloneJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite JSON number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains unsupported JSON value '${typeof value}'`);
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a circular reference`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error(`${path}[${index}] is a sparse array item`);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${path}[${index}] must be an enumerable data property`);
        }
        copy.push(cloneJson(
          descriptor.value,
          `${path}[${index}]`,
          ancestors,
        ));
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new Error(`${path} contains a non-JSON array property`);
        }
      }
      return Object.freeze(copy);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be a plain JSON object`);
    }
    const copy = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error(`${path} contains a symbol property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${propertyPath(path, key)} must be an enumerable data property`);
      }
      if (descriptor.value === undefined) continue;
      copy[key] = cloneJson(
        descriptor.value,
        propertyPath(path, key),
        ancestors,
      );
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * @spec Undefined object properties mean absence and are omitted recursively; null remains explicit.
 * @rule Top-level undefined, undefined array elements and holes are rejected, never converted to null.
 * @see {@link ../../../cli/docs/extension.md}
 */
export function immutableJsonValue(value: unknown, label: string): JsonValue {
  return cloneJson(value, label, new Set());
}

/** Normalize optional fields and create a deeply immutable JSON object without coercing unsupported data. */
export function immutableJsonObject(value: unknown, label: string): JsonObject {
  const snapshot = immutableJsonValue(value, label);
  if (snapshot === null || isJsonArray(snapshot) || typeof snapshot !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return snapshot;
}
