import { defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectInspect } from "./index";

export type InspectInput = Omit<Parameters<typeof runCollectInspect>[0], CommandHostOption>;

export const inspectCommand = defineCommand<InspectInput, void>({
  name: "doctor inspect",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.inspect,
  run: async (context, input) => runCollectInspect(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
