import { freezeTimeWindow, resolveTimeWindow } from "../time-window";
import { parseDataQueries } from "./query";
import { selectDataQueryServices } from "./config";
import { prepareCommandRequirements } from "../../command/prepare";
import { serializeData } from "./serialize";
import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectData } from "./index";
import { prepareDataCommand, type PreparedDataCommand } from "./context";
import type { CollectDataCliOpts, DataOutput } from "./model";
import { renderDataReport } from "./report";

export type DataInput = CommandInput & Omit<CollectDataCliOpts, CommandHostOption | "tenantId" | "tenantName" | "bizTypes" | "page" | "pageSize">;

export const dataCommand = defineCommand<DataInput, DataOutput, PreparedDataCommand>({
  serialize: serializeData,
  name: "doctor data",
  validate: (input) => {
    if (!input.bizIds?.some(id => id.trim())) throw new CommandInputError("doctor data 需要至少一个 biz-id");
    resolveTimeWindow(input);
    try { parseDataQueries(input); } catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
  },
  render: renderDataReport,
  prepare: async (context, input) => {
    input = freezeTimeWindow(input);
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.data });
    selectDataQueryServices(input, context.plugin.services);
    await prepareCommandRequirements(context, { environment: { kubernetes: true } });
    return prepareDataCommand(
      { ...input, ...commandOptions(context) }, context.plugin.services, context,
    );
  },
  run: (context, prepared) => runCollectData(prepared, context.plugin),
});
