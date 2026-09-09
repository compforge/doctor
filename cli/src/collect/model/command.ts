import { defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectModel } from "./index";

export type ModelInput = Omit<Parameters<typeof runCollectModel>[0], CommandHostOption>;

export const modelCommand = defineCommand<ModelInput, void>({
  name: "doctor model",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.model,
  run: async (context, input) => runCollectModel(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
