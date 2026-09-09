import { type CommandInput, defineCommand } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { runEval } from "./index";
import type { EvalCliOpts, EvalRun } from "./model";

export type EvalInput = CommandInput & Omit<EvalCliOpts, CommandHostOption>;
export const evalCommand = defineCommand<EvalInput, EvalRun>({
  name: "doctor eval", environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.eval,
  run: (context, input) => runEval({ ...input, ...commandOptions(context) }, context.plugin, context),
});
