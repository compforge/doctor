import { type CommandInput, defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectModel } from "./index";
import type { CollectModelCliOptions } from "./model";

export type ModelInput = CommandInput & Omit<CollectModelCliOptions, CommandHostOption>;

export const modelCommand = defineCommand<ModelInput, void>({
  name: "doctor model",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.model,
  run: async (context, input) => runCollectModel(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
