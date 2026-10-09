import type { PluginContext } from "../context";
import { validateOperation, type PluginOperation } from "../operation";
import { validateExtensionRegistration, type ExtensionRegistration } from "./registry";

export { withSummary, validateOperationResult as validateExtensionResult, type OperationResult as ExtensionResult } from "../operation";

/** Reuse the host's scoped access, clients, cancellation and cleanup contract. */
export type ExtensionContext = PluginContext;

/**
 * Service-provided function consumed at Command-owned call sites.
 * @spec kind owns the input/output contract; Core does not enumerate kinds or schedule their workflow
 * @spec access is readable without invoking run, so prepare can authorize before business execution
 */
export interface Extension<Input, Output> extends ExtensionRegistration, PluginOperation<Input, Output> {}

/** Discovered values cannot be invoked until a domain consumer establishes their input contract. */
export type RegisteredExtension = Extension<never, unknown>;

export function validateExtension(value: unknown): asserts value is RegisteredExtension {
  validateExtensionRegistration(value);
  validateOperation(value);
}

export * from "./facts-inspect";
export * from "./trace-resolve";
export * from "./trace-range";
export * from "./facet";
export * from "./duration";
export * from "./tenant";
export * from "./mcp";
export * from "./model";
export * from "./metric";
export * from "./perf";
export * from "./registry";
export * from "./workload";
export * from "./vdb";

export * from "./error-catalog";
export * from "./health";
