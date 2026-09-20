import { prepareCommandRequirements } from "../../command/prepare";
import { serializeData } from "./serialize";
import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectData } from "./index";
import { prepareDataCommand, type PreparedDataCommand } from "./context";
import type { CollectDataCliOpts, DataOutput } from "./model";
import { renderDataReport } from "./report";

export type DataInput = CommandInput & Omit<CollectDataCliOpts, CommandHostOption>;

export const dataCommand = defineCommand<DataInput, DataOutput, PreparedDataCommand>({
  serialize: serializeData,
  name: "doctor data",
  validate: (input) => {
    if (!input.bizIds?.some(id => id.trim())) throw new CommandInputError("doctor data 需要至少一个 biz-id");
  },
  render: renderDataReport,
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.data, environment: { kubernetes: true } });
    return prepareDataCommand(
      { ...input, ...commandOptions(context) }, context.plugin.services, context,
    );
  },
  run: (context, prepared) => runCollectData(prepared, context.plugin),
});
