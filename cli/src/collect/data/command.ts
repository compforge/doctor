import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectData } from "./index";
import { renderDataReport } from "./report";

export type DataInput = CommandInput & Omit<Parameters<typeof runCollectData>[0], CommandHostOption>;

export const dataCommand = defineCommand<DataInput, import("./model").DataOutput>({
  name: "doctor data",
  validate: (input) => {
    if (!input.bizIds?.some(id => id.trim())) throw new CommandInputError("doctor data 需要至少一个 biz-id");
  },
  render: renderDataReport,
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.data,
  run: async (context, input) => runCollectData(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
