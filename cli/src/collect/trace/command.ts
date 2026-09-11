import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectTrace } from "./index";
import { renderTraceReport } from "./report";

export type TraceInput = CommandInput & Omit<Parameters<typeof runCollectTrace>[0], CommandHostOption | "pageSize"> & { pageSize?: number };

export const traceCommand = defineCommand<TraceInput, import("./index").TraceOutput>({
  name: "doctor trace",
  render: renderTraceReport,
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.trace,
  validate: (input) => {
    if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize <= 0)) {
      throw new CommandInputError("--page-size 必须为正整数");
    }
  },
  run: async (context, input) => runCollectTrace(
    { ...input, ...commandOptions(context), pageSize: String(input.pageSize ?? 1000) }, context.plugin, context,
  ),
});
