import { validateSummary, type Summary } from "./summary";
import type { PluginContext } from "./context";
import type { CapabilityWithAccess } from "./kubernetes";

/**
 * Invocation contract shared by Service resources and registered Extensions.
 * @spec access is inspectable before run; invocation does not assign registration identity or scheduling policy
 */
export interface PluginOperation<Input, Output> extends CapabilityWithAccess {
  run(context: PluginContext, input: Input): Promise<OperationResult<Output>>;
}

/** Data may own live resources; validating the envelope does not consume or dispose them. */
export interface OperationResult<Output> {
  readonly data: Output;
  readonly summary: Summary;
}

/** Attach reading hints without changing the resource owner's lifecycle. */
export function withSummary<Input, Output>(summary: Summary,
  run: (context: PluginContext, input: Input) => Promise<Output>): PluginOperation<Input, Output>["run"] {
  return async (context, input) => ({ data: await run(context, input), summary });
}

export function validateOperationResult(value: unknown): asserts value is OperationResult<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "data")) throw new Error("Operation result requires data");
  validateSummary((value as OperationResult<unknown>).summary);
}

export function validateOperation(value: unknown): asserts value is PluginOperation<never, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Operation must be an object");
  const operation = value as Record<string, unknown>;
  if (!operation.access || typeof operation.access !== "object" || Array.isArray(operation.access)) throw new Error("Operation.access must be an object");
  if (typeof operation.run !== "function") throw new Error("Operation.run must be a function");
}
