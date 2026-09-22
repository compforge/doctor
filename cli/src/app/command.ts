import type { PluginDefinition } from "@compforge/doctor-plugin";
import { CommandInputError, CommandStatus, type CommandInput, type CommandResult, type Command } from "../command";
import { reportError } from "./error-report";
import { finalizeCommand } from "./finalize";
import { prepareCommand, type CommandOptions } from "./prepare";
import { withLogger } from "../terminal/log";
import { deliverPreparationFailure } from "./preparation-failure";
import { withoutShadowedDefaults } from "./option-sources";
import { withInteractionOptions } from "../terminal/policy";
import type { Distribution } from "./distribution";

export type { Command } from "../command";

export function commandExitCode(result: CommandResult<unknown>): number {
  switch (result.status) {
    case CommandStatus.Ok:
    case CommandStatus.Partial: return 0;
    case CommandStatus.Cancelled: return 130;
    case CommandStatus.Failed: return result.error instanceof CommandInputError ? 2 : 1;
  }
}

export type CommandRuntime = {
  plugin?: PluginDefinition;
  printProfile?: boolean;
  logLevel?: Distribution["logLevel"];
};

/** The only profile-aware CLI lifecycle: execute a spec, then deliver exactly once. */
export async function runCommand<Input extends CommandInput, Output>(
  spec: Command<Input, Output>,
  opts: CommandOptions,
  input: Input,
  runtime: CommandRuntime = {},
): Promise<void> {
  return withInteractionOptions(opts, () =>
    withLogger(runtime.logLevel ?? "info", () => executeCommand(spec, opts, input, runtime)));
}

async function executeCommand<Input extends CommandInput, Output>(
  spec: Command<Input, Output>, opts: CommandOptions, input: Input,
  runtime: CommandRuntime,
): Promise<void> {
  try {
    const context = prepareCommand(opts, runtime.printProfile ?? true, runtime.plugin);
    input = withoutShadowedDefaults(input, context.profile.value);
    const interrupt = () => context.cancel(new Error(`${spec.name} interrupted`));
    process.once("SIGINT", interrupt);
    try {
      let result: CommandResult<Output>;
      try { result = await spec.run(context, input); }
      catch (error) {
        reportError(error, { context: spec.name, summary: "fatal" });
        result = { status: CommandStatus.Failed, artifacts: [], error };
      }
      context.artifacts.add(result.artifacts);
      process.exitCode = await finalizeCommand({
        spec, commandInput: input, result, context, delivery: opts, code: commandExitCode(result),
      });
    } finally { process.removeListener("SIGINT", interrupt); }
  } catch (error) {
    reportError(error, { context: spec.name, summary: "fatal" });
    process.exitCode = opts.format?.trim() === "manifest"
      ? await deliverPreparationFailure(spec.name, error instanceof Error ? error.message : String(error), opts.output)
      : 1;
  }
}

/** Bootstrap/offline commands do not require an existing profile. */
export async function runStandaloneCommand(
  context: string, action: () => Promise<number | void>,
): Promise<void> {
  try {
    const code = await action();
    if (typeof code === "number") process.exitCode = code;
  } catch (error) {
    reportError(error, { context, summary: "fatal" });
    process.exitCode = error instanceof CommandInputError ? 2 : 1;
  }
}
