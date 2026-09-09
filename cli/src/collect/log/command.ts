import { defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectLog } from "./index";

export type LogInput = Omit<Parameters<typeof runCollectLog>[0], CommandHostOption>;

export const logCommand = defineCommand<LogInput, void>({
  name: "doctor log",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.log,
  run: async (context, input) => runCollectLog(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
