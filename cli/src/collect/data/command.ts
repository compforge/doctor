import { type CommandInput, defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectData } from "./index";

export type DataInput = CommandInput & Omit<Parameters<typeof runCollectData>[0], CommandHostOption>;

export const dataCommand = defineCommand<DataInput, void | import("./model").DataOutput>({
  name: "doctor data",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.data,
  run: async (context, input) => runCollectData(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
