import { validateSummary, type Summary } from "../summary";
import type { PluginContext } from "../context";
import type { CapabilityAccess } from "../kubernetes";
import { validateExtensionRegistration, type ExtensionRegistration } from "./registry";

/** Reuse the host's scoped access, clients, cancellation and cleanup contract. */
export type ExtensionContext = PluginContext;

/**
 * Service-provided function consumed at Command-owned call sites.
 * @spec kind owns the input/output contract; Core does not enumerate kinds or schedule their workflow
 * @spec access is readable without invoking run, so prepare can authorize before business execution
 */
export interface Extension<Input, Output> extends ExtensionRegistration {
  readonly access: CapabilityAccess;
  run(context: ExtensionContext, input: Input): Promise<ExtensionResult<Output>>;
}

/** Data can own live resources; the host validates only the envelope here. */
export interface ExtensionResult<Output> {
  readonly data: Output;
  readonly summary: Summary;
}

/** Attach declarative reading hints without consuming streams or changing resource ownership. */
export function withSummary<Input, Output>(summary: Summary,
  run: (context: ExtensionContext, input: Input) => Promise<Output>): Extension<Input, Output>["run"] {
  return async (context, input) => ({ data: await run(context, input), summary });
}

export function validateExtensionResult(value: unknown): asserts value is ExtensionResult<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "data")) throw new Error("Extension result requires data");
  validateSummary((value as ExtensionResult<unknown>).summary);
}

/** Discovered values cannot be invoked until a domain consumer establishes their input contract. */
export type RegisteredExtension = Extension<never, unknown>;

export function validateExtension(value: unknown): asserts value is RegisteredExtension {
  validateExtensionRegistration(value);
  const item = value as unknown as Record<string, unknown>;
  if (!item.access || typeof item.access !== "object" || Array.isArray(item.access)) throw new Error("Extension.access must be an object");
  if (typeof item.run !== "function") throw new Error("Extension.run must be a function");
}

export * from "./facts-inspect";
export * from "./trace-resolve";
export * from "./trace-range";
export * from "./overview";
export * from "./tenant";
export * from "./mcp";
export * from "./model";
export * from "./metric";
export * from "./perf";
export * from "./case";
export * from "./case-catalog";
export * from "./registry";
export * from "./workload";
export * from "./vdb";
