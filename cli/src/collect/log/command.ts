import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { validateLogTimeWindow } from "./config";
import { runCollectLog } from "./index";
import { renderLogReport } from "./report";

export type LogInput = CommandInput & Omit<Parameters<typeof runCollectLog>[0], CommandHostOption>;

export const logCommand = defineCommand<LogInput, import("./index").LogOutput>({
  name: "doctor log",
  render: renderLogReport,
  validate: (input) => {
    try { validateLogTimeWindow(input); }
    catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
  },
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.log,
  run: async (context, input) => runCollectLog(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
