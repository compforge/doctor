import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type {
  JsonObject,
  JsonValue,
  ObservationDefinition,
  ObservationValue,
} from "@compforge/doctor-plugin";

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const PORTABLE_TYPEBOX_METADATA = new Set([
  "~immutable",
  "~kind",
  "~optional",
  "~readonly",
]);

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  strictNumbers: true,
  useDefaults: false,
});
addFormats(ajv);

const validators = new WeakMap<object, ValidateFunction>();

function propertyPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

function cloneJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  ignoreTypeBoxMetadata = false,
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
          ignoreTypeBoxMetadata,
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
      if (ignoreTypeBoxMetadata && !descriptor.enumerable && key.startsWith("~")) {
        if (!PORTABLE_TYPEBOX_METADATA.has(key)) {
          throw new Error(`${propertyPath(path, key)} is not portable JSON Schema metadata`);
        }
        continue;
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${propertyPath(path, key)} must be an enumerable data property`);
      }
      copy[key] = cloneJson(
        descriptor.value,
        propertyPath(path, key),
        ancestors,
        ignoreTypeBoxMetadata,
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

/** Create a lossless, deeply immutable JSON snapshot without JavaScript coercion. */
export function immutableJsonValue(value: unknown, label: string): JsonValue {
  return cloneJson(value, label, new Set());
}

/** Create a lossless, deeply immutable JSON object instead of relying on JSON.stringify coercion. */
export function immutableJsonObject(value: unknown, label: string): JsonObject {
  const snapshot = immutableJsonValue(value, label);
  if (snapshot === null || isJsonArray(snapshot) || typeof snapshot !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return snapshot;
}

function childSchemas(schema: JsonObject): JsonValue[] {
  const children: JsonValue[] = [];
  const add = (value: JsonValue | undefined) => {
    if (typeof value === "boolean" || (value && !isJsonArray(value) && typeof value === "object")) {
      children.push(value);
    }
  };
  const addArray = (value: JsonValue | undefined) => {
    if (value && isJsonArray(value)) value.forEach(add);
  };
  const addMap = (value: JsonValue | undefined) => {
    if (value && !isJsonArray(value) && typeof value === "object") Object.values(value).forEach(add);
  };

  for (const keyword of [
    "additionalProperties",
    "contentSchema",
    "contains",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ]) add(schema[keyword]);
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) addArray(schema[keyword]);
  for (const keyword of ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]) {
    addMap(schema[keyword]);
  }
  return children;
}

function validateSchemaPolicy(schema: JsonValue, label: string, path: string = "$"): void {
  if (schema === false) return;
  if (schema === true) throw new Error(`${label}${path} must not be an unconstrained schema`);
  if (schema === null || isJsonArray(schema) || typeof schema !== "object") {
    throw new Error(`${label}${path} must be a JSON Schema object`);
  }
  if (schema.$schema !== undefined && schema.$schema !== JSON_SCHEMA_DIALECT) {
    throw new Error(`${label}${path} must use JSON Schema Draft 2020-12`);
  }
  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    const reference = schema[keyword];
    if (typeof reference === "string" && reference !== "#" && !reference.startsWith("#/")) {
      throw new Error(`${label}${path} must not use a remote ${keyword}`);
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const type of types) {
    if (type !== undefined && (typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))) {
      throw new Error(`${label}${path}.type '${String(type)}' is not a JSON type`);
    }
  }
  const hasComposition = ["allOf", "anyOf", "oneOf"].some((keyword) => {
    const value = schema[keyword];
    return Array.isArray(value) && value.length > 0;
  });
  if (
    schema.type === undefined
    && schema.$ref === undefined
    && schema.$dynamicRef === undefined
    && !hasComposition
  ) {
    throw new Error(`${label}${path} must declare type, local $ref, or composition`);
  }
  if (types.includes("object") && !Object.hasOwn(schema, "additionalProperties")) {
    throw new Error(`${label}${path} object schema must declare additionalProperties`);
  }
  if (types.includes("object") && schema.additionalProperties === true) {
    throw new Error(`${label}${path}.additionalProperties must be false or a constrained schema`);
  }
  childSchemas(schema).forEach((child, index) => {
    validateSchemaPolicy(child, label, `${path}.schema[${index}]`);
  });
}

/** Validate and compile one Plugin-declared Observation schema at Plugin load time. */
export function validateObservationSchema(schema: unknown, label: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${label} must be a JSON Schema object`);
  }
  if (validators.has(schema)) return;

  const snapshot = cloneJson(schema, label, new Set(), true);
  if (snapshot === null || isJsonArray(snapshot) || typeof snapshot !== "object") {
    throw new Error(`${label} must be a JSON Schema object`);
  }
  const normalized = snapshot;
  if (normalized.type !== "object") throw new Error(`${label} root type must be object`);
  validateSchemaPolicy(normalized, label);
  try {
    validators.set(schema, ajv.compile(normalized));
  } catch (error) {
    throw new Error(
      `${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => {
    const path = error.instancePath || "/";
    return `${path} ${error.message ?? "is invalid"}`;
  }).join("; ");
}

/**
 * Validate a dynamic Plugin result and return the immutable JSON snapshot admitted into Evidence.
 *
 * @spec Core treats every Plugin Observation result as unknown until it passes JSON and declared-schema validation
 * @rule Validation never coerces, fills defaults, strips fields, or retains the Plugin-owned object reference
 */
export function validateObservationValue<const Definition extends ObservationDefinition>(
  definition: Definition,
  value: unknown,
  label: string,
): ObservationValue<Definition> {
  validateObservationSchema(definition.schema, `${label}.schema`);
  const snapshot = immutableJsonObject(value, `${label}.value`);
  const validator = validators.get(definition.schema)!;
  if (!validator(snapshot)) {
    throw new Error(
      `${label}.value does not match ${definition.kind}@${definition.schemaVersion}: `
      + validationMessage(validator.errors),
    );
  }
  return snapshot as ObservationValue<Definition>;
}
