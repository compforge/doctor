import { freezeTimeWindow, resolveTimeWindow } from "../time-window";
import { DATA_LIST_KIND } from "@compforge/doctor-plugin";
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

export type DataInput = CommandInput & Omit<CollectDataCliOpts, CommandHostOption>;

export const dataCommand = defineCommand<DataInput, DataOutput, PreparedDataCommand>({
  serialize: serializeData,
  name: "doctor data",
  validate: (input) => {
    resolveTimeWindow(input);
    try { parseDataQueries(input); } catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
  },
  render: renderDataReport,
  prepare: async (context, input) => {
    input = freezeTimeWindow(input);
    const queries = parseDataQueries(input);
    await prepareCommandRequirements(context, { plugin: {
      command: PLUGIN_COMMAND_CAPABILITIES.data.command,
      needs: [
        ...(queries.ids.length ? PLUGIN_COMMAND_CAPABILITIES.data.needs : []),
        ...(queries.list ? [{ requirement: "required" as const, capability: { scope: "extension" as const, name: DATA_LIST_KIND }, purpose: "按业务类型分页查询数据" }] : []),
      ],
    } });
    selectDataQueryServices(input, context.plugin.services);
    await prepareCommandRequirements(context, { environment: { kubernetes: true } });
    return prepareDataCommand(
      { ...input, ...commandOptions(context) }, context.plugin.services, context,
    );
  },
  run: (context, prepared) => runCollectData(prepared, context.plugin),
});
