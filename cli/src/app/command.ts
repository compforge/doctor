import type { PluginDefinition } from "@compforge/doctor-plugin";
import { CommandInputError, CommandStatus, type CommandResult, type CommandSpec } from "../command";
import { reportError } from "./error-log";
import { finalizeCommand } from "./finalize";
import { prepareCommand, type CommandOptions } from "./prepare";

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
export async function runCommand<Input, Output>(
  spec: CommandSpec<Input, Output>,
  opts: CommandOptions,
  input: Input,
  runtime: { plugin?: PluginDefinition; printProfile?: boolean } = {},
): Promise<void> {
  try {
    const context = prepareCommand(opts, runtime.printProfile ?? true, runtime.plugin);
    const interrupt = () => context.cancel(new Error(`${spec.name} interrupted`));
    process.once("SIGINT", interrupt);
    let result: CommandResult<Output>;
    try { result = await spec.run(context, input); }
    finally { process.removeListener("SIGINT", interrupt); }
    context.artifacts.include(result.artifacts);
    if (result.reportName) context.artifacts.setReportName(result.reportName);
    process.exitCode = await finalizeCommand({
      command: spec.name, context, delivery: opts, code: commandExitCode(result),
    });
  } catch (error) {
    reportError(error, { context: spec.name, summary: "fatal" });
    process.exitCode = 1;
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
    process.exitCode = 1;
  }
}
