import { validateOperationResult, type OperationResult, type PluginOperation, type PluginContext } from "@compforge/doctor-plugin";

/** Invoke only with a host-created context scoped to this operation's declared access. */
export async function invokeOperation<Input, Output>(
  operation: PluginOperation<Input, Output>, context: PluginContext, input: Input,
): Promise<OperationResult<Output>> {
  context.signal.throwIfAborted();
  const output = await operation.run(context, input);
  context.signal.throwIfAborted();
  validateOperationResult(output);
  return output;
}
