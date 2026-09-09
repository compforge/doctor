import type { CommandArtifact } from "./artifacts";
import { CommandStatus } from "./status";

interface CommandResultArtifacts {
  readonly artifacts: readonly CommandArtifact[];
  readonly reportName?: string;
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

export class CommandInputError extends Error {}

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
