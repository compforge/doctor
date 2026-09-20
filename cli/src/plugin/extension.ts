import type { Extension, ExtensionContext } from "@compforge/doctor-plugin";

/** Invoke only with a host-created context scoped to this Extension's declared access. */
export async function invokeExtension<Input, Output>(
  extension: Extension<Input, Output>, context: ExtensionContext, input: Input,
): Promise<Output> {
  context.signal.throwIfAborted();
  const output = await extension.run(context, input);
  context.signal.throwIfAborted();
  return output;
}
