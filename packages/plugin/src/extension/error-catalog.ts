import { validateExtensionRegistration, type ExtensionRegistration } from "./registry";

export const ERROR_CATALOG_KIND = "error.catalog";

/** Published defaults describe a definition, never the state or recovery policy of a live error. */
export interface ErrorDefinition {
  /** Opaque machine code; use strings for numeric codes too, preserving leading zeroes. */
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly exception?: string;
  readonly defaultMessage?: string;
  readonly defaultHttpStatus?: number;
  readonly defaultDisposition?: string;
  readonly references?: readonly string[];
}

export interface ErrorCatalog {
  /** Version of the definitions, independently of the containing Plugin's release. */
  readonly source: { readonly name: string; readonly version: string; readonly reference?: string };
  readonly errors: readonly ErrorDefinition[];
}

/** Offline definitions. Loading must not open target access or require a Service context. */
export interface ErrorCatalogExtension extends ExtensionRegistration {
  readonly kind: typeof ERROR_CATALOG_KIND;
  load(): ErrorCatalog;
}

export function requireErrorCatalogExtension(value: unknown): ErrorCatalogExtension {
  validateExtensionRegistration(value);
  const item = value as Partial<ErrorCatalogExtension>;
  if (item.kind !== ERROR_CATALOG_KIND || typeof item.load !== "function") {
    throw new Error(`${item.id}: invalid error.catalog Extension`);
  }
  return item as ErrorCatalogExtension;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

/**
 * @spec Names are unique within one catalog; codes may repeat across distinct definitions.
 * @why Numeric aliases and wrapped exceptions do not have a one-to-one code-to-class mapping.
 */
export function loadErrorCatalog(extension: ErrorCatalogExtension): ErrorCatalog {
  const label = `${extension.id}: error.catalog`;
  const value = record(extension.load(), label);
  const source = record(value.source, `${label}.source`);
  const names = new Set<string>();
  if (!Array.isArray(value.errors)) throw new Error(`${label}.errors must be an array`);
  return {
    source: {
      name: string(source.name, `${label}.source.name`),
      version: string(source.version, `${label}.source.version`),
      ...(source.reference === undefined ? {} : { reference: string(source.reference, `${label}.source.reference`) }),
    },
    errors: value.errors.map((item, index) => {
      const path = `${label}.errors[${index}]`;
      const raw = record(item, path);
      const name = string(raw.name, `${path}.name`);
      if (names.has(name)) throw new Error(`${label}: duplicate error name '${name}'`);
      names.add(name);
      const error: ErrorDefinition = {
        code: string(raw.code, `${path}.code`), name,
        description: string(raw.description, `${path}.description`),
      };
      const text = Object.fromEntries(["exception", "defaultMessage", "defaultDisposition"].flatMap(key =>
        raw[key] === undefined ? [] : [[key, string(raw[key], `${path}.${key}`)]]));
      if (raw.defaultHttpStatus !== undefined && (typeof raw.defaultHttpStatus !== "number"
        || !Number.isInteger(raw.defaultHttpStatus) || raw.defaultHttpStatus < 100 || raw.defaultHttpStatus > 599)) {
        throw new Error(`${path}.defaultHttpStatus must be an HTTP status between 100 and 599`);
      }
      return {
        ...error, ...text,
        ...(raw.defaultHttpStatus === undefined ? {} : { defaultHttpStatus: raw.defaultHttpStatus as number }),
        ...(raw.aliases === undefined ? {} : { aliases: strings(raw.aliases, `${path}.aliases`) }),
        ...(raw.references === undefined ? {} : { references: strings(raw.references, `${path}.references`) }),
      };
    }),
  };
}
