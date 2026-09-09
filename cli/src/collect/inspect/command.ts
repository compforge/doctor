import { type CommandInput, defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectInspect } from "./index";

export type InspectInput = CommandInput & Omit<Parameters<typeof runCollectInspect>[0], CommandHostOption>;

/** Environment and delivery are fixed by Context; these fields define the collection scope. */
export function createInspectInput(input: Omit<InspectInput, "idempotencyKey">): InspectInput {
  return {
    ...input,
    idempotencyKey() {
      return JSON.stringify([this.namespace ?? null, this.services ?? null, this.deploymentConfig ?? null, this.dependencies ?? null]);
    },
  };
}

export const inspectCommand = defineCommand<InspectInput, void>({
  name: "doctor inspect",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.inspect,
  run: async (context, input) => runCollectInspect(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
