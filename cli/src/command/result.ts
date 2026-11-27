import { DoctorError } from "@compforge/doctor-plugin";
import type { ExecutionDiagnostic } from "./diagnostic";
import type { Summary } from "@compforge/harness-common";
import type { CommandArtifact } from "./artifacts";
import { CommandStatus } from "./status";

interface CommandResultArtifacts {
  readonly diagnostics?: readonly ExecutionDiagnostic[];
  readonly summary?: Summary;
  readonly artifacts: readonly CommandArtifact[];
}

export type CommandResult<Output> = CommandResultArtifacts & (
  | {
      readonly status: CommandStatus.Ok | CommandStatus.Partial;
      readonly output: Output;
    }
  | {
      readonly status: CommandStatus.Failed | CommandStatus.Cancelled;
      readonly output?: Output;
      readonly reason?: string;
      readonly error?: unknown;
    }
);

/**
 * @spec Record the first Command that observes this error and preserve that origin across parents.
 * @link cli/docs/command.md#doctorerror
 */
export class CommandError extends DoctorError {
  #command?: string;

  get command(): string | undefined { return this.#command; }

  recordCommand(command: string): string { return this.#command ??= command; }
}

/** @spec Abort the current command tree and retain the error as the root failure. */
export class CommandAbortError extends CommandError {}

export class CommandInputError extends CommandError {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, { ...options, code: "invalid_argument" });
  }
}

export function recordCommandError(error: unknown, command: string): string {
  return error instanceof CommandError ? error.recordCommand(command) : command;
}

/** A parent calls this only for work required by its own objective. Empty work is complete. */
export function aggregateCommandStatus(statuses: readonly CommandStatus[]): CommandStatus {
  if (statuses.includes(CommandStatus.Cancelled)) return CommandStatus.Cancelled;
  if (statuses.every((status) => status === CommandStatus.Ok)) return CommandStatus.Ok;
  return statuses.some((status) => status === CommandStatus.Ok || status === CommandStatus.Partial)
    ? CommandStatus.Partial : CommandStatus.Failed;
}

/** Adapts the existing collector engine's numeric completion at the command boundary. */
export function commandOutcome(code: number | void): CommandResult<void> {
  if (code === undefined || code === 0) return { status: CommandStatus.Ok, output: undefined, artifacts: [] };
  if (code === 130) return { status: CommandStatus.Cancelled, artifacts: [] };
  const reason = `Command execution failed (exit ${code})`;
  return { status: CommandStatus.Failed, artifacts: [], reason,
    error: code === 2 ? new CommandInputError(reason) : undefined };
}
