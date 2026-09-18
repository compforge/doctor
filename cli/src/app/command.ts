import type { PluginDefinition } from "@compforge/doctor-plugin";
import { CommandInputError, CommandStatus, type CommandInput, type CommandResult, type CommandSpec } from "../command";
import { reportError } from "./error-log";
import { finalizeCommand } from "./finalize";
import { prepareCommand, type CommandOptions } from "./prepare";
import { withMachineOutput } from "../terminal/output";
import { deliverManifest } from "./manifest-delivery";
import { withoutShadowedDefaults } from "./option-sources";
import { withInteractionOptions } from "../terminal/policy";

export type { CommandSpec } from "../command";

export function commandExitCode(result: CommandResult<unknown>): number {
  switch (result.status) {
    case CommandStatus.Ok:
    case CommandStatus.Partial: return 0;
    case CommandStatus.Cancelled: return 130;
    case CommandStatus.Failed: return result.error instanceof CommandInputError ? 2 : 1;
  }
}

/** The only profile-aware CLI lifecycle: execute a spec, then deliver exactly once. */
export async function runCommand<Input extends CommandInput, Output>(
  spec: CommandSpec<Input, Output>,
  opts: CommandOptions,
  input: Input,
  runtime: { plugin?: PluginDefinition; printProfile?: boolean } = {},
): Promise<void> {
  return withInteractionOptions(opts, () =>
    withMachineOutput(opts.format?.trim() === "manifest", () => executeCommand(spec, opts, input, runtime)));
}

async function executeCommand<Input extends CommandInput, Output>(
  spec: CommandSpec<Input, Output>, opts: CommandOptions, input: Input,
  runtime: { plugin?: PluginDefinition; printProfile?: boolean },
): Promise<void> {
  try {
    const context = prepareCommand(opts, runtime.printProfile ?? true, runtime.plugin);
    input = withoutShadowedDefaults(input, context.profile.value);
    const interrupt = () => context.cancel(new Error(`${spec.name} interrupted`));
    process.once("SIGINT", interrupt);
    let result: CommandResult<Output>;
    try {
      try { result = await spec.run(context, input); }
      catch (error) {
        reportError(error, { context: spec.name, summary: "fatal" });
        result = { status: CommandStatus.Failed, artifacts: [], error };
      }
      context.artifacts.add(result.artifacts);
      if (result.reportName) context.artifacts.setReportName(result.reportName);
      process.exitCode = await finalizeCommand({
        command: spec.name, context, delivery: opts, code: commandExitCode(result),
        result: { status: result.status, reason: "reason" in result ? result.reason : undefined },
        render: renderer => renderer.render(spec, result),
      });
    } finally { process.removeListener("SIGINT", interrupt); }
  } catch (error) {
    reportError(error, { context: spec.name, summary: "fatal" });
    process.exitCode = opts.format?.trim() === "manifest"
      ? deliverManifest({ command: spec.name, code: 1, output: opts.output,
          result: { status: CommandStatus.Failed, reason: error instanceof Error ? error.message : String(error) } }).code
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
