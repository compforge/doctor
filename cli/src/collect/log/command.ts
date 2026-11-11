import { timePaddingMs, validateLogTimeWindow } from "./window";
import { freezeTimeWindow } from "../time-window";
import { prepareCommandRequirements } from "../../command/prepare";
import { serializeEvidenceResult } from "../serialize";
import { CommandInputError, defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectLog } from "./index";
import { renderLogReport } from "./report";

export type LogInput = CommandInput & Omit<Parameters<typeof runCollectLog>[0], CommandHostOption>;

export const logCommand = defineCommand<LogInput, import("./index").LogOutput>({
  serialize: serializeEvidenceResult,
  name: "doctor log",
  render: renderLogReport,
  validate: (input) => {
    for (const name of ["pod", "container"] as const) {
      if (input[name] !== undefined && !input[name]?.trim()) throw new CommandInputError(`--${name} 需要非空名称`);
    }
    try { validateLogTimeWindow(input); timePaddingMs(input.timePadding); }
    catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
  },
  prepare: async (context, input) => {
    input = { ...freezeTimeWindow(input), collectionStartedAt: input.collectionStartedAt ?? new Date().toISOString() };
    if (context.options.format?.trim() === "summary" && context.options.output) {
      throw new CommandInputError("--format summary 直接输出到终端，不支持 --output");
    }
    await prepareCommandRequirements(context, {
      environment: { kubernetes: true },
      plugin: PLUGIN_COMMAND_CAPABILITIES.log,
    });
    return input;
  },
  run: async (context, input) => runCollectLog(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
