import { freezeTimeWindow } from "../time-window";
import { dataCommand } from "../data/command";
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
  serialize: async (context, result) => {
    const identityResolution = result.output?.identityResolution;
    const own = await serializeEvidenceResult(context, { ...result, artifacts: result.artifacts.filter(item => item.command === "log") });
    return { ...own, children: [...(own.children ?? []), ...(identityResolution ? [await context.serialize(dataCommand, identityResolution)] : [])] };
  },
  name: "doctor log",
  render: renderLogReport,
  validate: (input) => {
    try { validateLogTimeWindow(input); }
    catch (error) { throw new CommandInputError(error instanceof Error ? error.message : String(error)); }
  },
  prepare: async (context, input) => {
    input = freezeTimeWindow(input);
    if (context.options.format?.trim() === "summary" && context.options.output) {
      throw new CommandInputError("--format summary 直接输出到终端，不支持 --output");
    }
    await prepareCommandRequirements(context, {
      environment: { kubernetes: true },
      plugin: {
        ...PLUGIN_COMMAND_CAPABILITIES.log,
        needs: [
          ...PLUGIN_COMMAND_CAPABILITIES.log.needs,
          ...(input.bizIds.some(id => id.trim()) && !context.plugin.services.services.some(service => service.logs?.identityRelations)
            ? PLUGIN_COMMAND_CAPABILITIES.trace.needs : []),
        ],
      },
    });
    return input;
  },
  run: async (context, input) => runCollectLog(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
