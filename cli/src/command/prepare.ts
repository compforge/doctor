import type { CommandContext, EnvironmentRequirements } from "./context";
import type { PluginCapabilityContract } from "./plugin-capability";
import { requirePluginCapabilities } from "../terminal/plugin-capability";

/** Requirements known from the input, before selecting or calling a concrete implementation. */
export interface CommandRequirements {
  readonly environment?: EnvironmentRequirements;
  readonly plugin?: PluginCapabilityContract;
}

/**
 * Check declarations before environment access. Concrete capability/Extension access is checked
 * after selection, before its first external call; a catalog match alone grants no access.
 */
export async function prepareCommandRequirements(context: CommandContext, requirements: CommandRequirements): Promise<void> {
  context.signal.throwIfAborted();
  if (requirements.plugin) requirePluginCapabilities(await context.resolvePlugin(), requirements.plugin);
  context.signal.throwIfAborted();
  await context.ensureEnvironment(requirements.environment ?? {});
  context.signal.throwIfAborted();
}
