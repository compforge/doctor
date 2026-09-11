import { defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectData } from "./index";
import { renderDataReport } from "./report";

export type DataInput = CommandInput & Omit<Parameters<typeof runCollectData>[0], CommandHostOption>;

export const dataCommand = defineCommand<DataInput, import("./model").DataOutput>({
  name: "doctor data",
  render: renderDataReport,
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.data,
  run: async (context, input) => runCollectData(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
