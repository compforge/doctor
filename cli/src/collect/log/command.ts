import { prepareCommandRequirements } from "../../command/prepare";
import { serializeEvidenceResult } from "../serialize";
import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { validateLogTimeWindow } from "./config";
import { runCollectLog } from "./index";
import { renderLogReport } from "./report";

export type LogInput = CommandInput & Omit<Parameters<typeof runCollectLog>[0], CommandHostOption>;

export const logCommand = defineCommand<LogInput, import("./index").LogOutput>({
  serialize: serializeEvidenceResult,
  name: "doctor log",
  render: renderLogReport,
  validate: (input) => {
    try { validateLogTimeWindow(input); }
    catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
  },
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, {
      environment: { kubernetes: true },
      plugin: input.bizIds.some(id => id.trim()) ? PLUGIN_COMMAND_CAPABILITIES.log : {
        ...PLUGIN_COMMAND_CAPABILITIES.log,
        needs: PLUGIN_COMMAND_CAPABILITIES.log.needs.filter(need => need.capability.name !== "traceId"),
      },
    });
    return input;
  },
  run: async (context, input) => runCollectLog(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
