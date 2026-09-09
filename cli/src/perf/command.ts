import { defineCommand } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { runPerf } from "./index";
import type { PerfCliOpts, PerfResult } from "./model";

export type PerfInput = Omit<PerfCliOpts, CommandHostOption>;
export const perfCommand = defineCommand<PerfInput, PerfResult>({
  name: "doctor perf", environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.perf,
  run: (context, input) => runPerf({ ...input, ...commandOptions(context) }, context.plugin, context),
});
