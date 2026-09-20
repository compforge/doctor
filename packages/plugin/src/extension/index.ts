import type { PluginContext } from "../context";
import type { CapabilityAccess } from "../kubernetes";

/** Reuse the host's scoped access, clients, cancellation and cleanup contract. */
export type ExtensionContext = PluginContext;

/**
 * Service-provided function consumed at Command-owned call sites.
 * @spec kind owns the input/output contract; Core does not enumerate kinds or schedule their workflow
 * @spec access is readable without invoking run, so prepare can authorize before business execution
 */
export interface Extension<Input, Output> {
  readonly id: string;
  readonly kind: string;
  readonly description?: string;
  readonly access: CapabilityAccess;
  run(context: ExtensionContext, input: Input): Promise<Output>;
}

/** Discovered values cannot be invoked until a domain consumer establishes their input contract. */
export type RegisteredExtension = Extension<never, unknown>;

export function validateExtension(value: unknown): asserts value is RegisteredExtension {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Extension must be an object");
  const item = value as Record<string, unknown>;
  for (const field of ["id", "kind"] as const) {
    if (typeof item[field] !== "string" || !item[field].trim()) throw new Error(`Extension.${field} must be a non-empty string`);
  }
  if (item.description !== undefined && typeof item.description !== "string") throw new Error("Extension.description must be a string");
  if (!item.access || typeof item.access !== "object" || Array.isArray(item.access)) throw new Error("Extension.access must be an object");
  if (typeof item.run !== "function") throw new Error("Extension.run must be a function");
}

export * from "./facts-inspect";
export * from "./trace-resolve";
export * from "./overview";
export { serviceExtensions } from "./service-extensions";
export * from "./tenant";
export * from "./mcp";
export * from "./model";
export * from "./metric";
export * from "./perf";
export * from "./case";
export * from "./workload";
