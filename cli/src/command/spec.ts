import { executionDiagnostic, diagnosticMessage, type ExecutionDiagnostic } from "./diagnostic";
import { useLogger } from "../terminal/log";
import type { CommandContext } from "./context";
import { currentCommandClients, inCommandScope, recordExecutionDiagnostics, withRunSignal } from "./execution-scope";
import { CommandAbortError, type CommandResult } from "./result";
import { CommandStatus } from "./status";
import { withInteractionOptions } from "../terminal/policy";

import type { RenderContext } from "../report/context";
import type { Report } from "../report/model";
import type { SerializeContext } from "./serialization/context";
import type { SerializedOutput } from "./serialization/model";

export interface CommandInput {
  yes?: boolean;
  /** Same command/key share one execution within a Context; omit for independent calls. */
  idempotencyKey?(): string;
}

export interface CommandSpec<Input extends CommandInput, Output, Prepared = Input> {
  readonly name: string;
  /** Pure input validation, before Plugin loading, environment access and idempotent reuse. */
  readonly validate?: (input: Input) => void | Promise<void>;
  /**
   * @spec Resolve the configuration known before execution and return it with the bound dependencies in Prepared.
   * A choice that depends on later evidence is settled before the action that needs it.
   * Return undefined to cancel the invocation.
   */
  prepare(context: CommandContext, input: Input): Promise<Prepared | undefined>;
  run(context: CommandContext, prepared: Prepared): Promise<CommandResult<Output>>;
  /** Root delivery derives a name from input and available output, including failed or cancelled results. */
  reportName?(input: Input, result: CommandResult<Output>, now: Date): string | undefined;
  /** Root finalize persists local results before rendering. No collection or remote access. */
  serialize?(context: SerializeContext, result: CommandResult<Output>): Promise<SerializedOutput>;
  /** Root finalize renders local results. Commands without a report (for example chat) omit this hook. */
  render?(context: RenderContext, result: CommandResult<Output>): Promise<Report>;
}

/** Public calls always take Input; preparation is owned by the checked entry point. */
export type Command<Input extends CommandInput, Output> = Omit<CommandSpec<Input, Output>, "prepare">;

/**
 * @spec CLI and parent commands call the same checked run entry point.
 * @spec Prepare and run share one invocation scope and one idempotency decision; only ready work runs.
 * @spec Every command prepares its own requirements; aggregate calls prepare children independently.
 * @rule User interrupts stop domain work. Preparation and invocation cleanup share the root client lifetime.
 * @link cli/docs/command.md#三阶段生命周期
 * Each invocation owns its artifacts and temporary cleanup; root resources and environment are shared.
 */
export function defineCommand<Input extends CommandInput, Output, Prepared = Input>(
  spec: CommandSpec<Input, Output, Prepared>,
): Command<Input, Output> {
  const { prepare: _prepare, run: _run, ...metadata } = spec;
  return {
    ...metadata,
    run: (context, input) => withInteractionOptions({ yes: input.yes ?? context.options.yes }, async (): Promise<CommandResult<Output>> => {
      const nested = currentCommandClients() === context.clients;
      const invocationStartedAt = Date.now();
      const execute = async () => {
        const diagnostics: ExecutionDiagnostic[] = [];
        let phase = "prepare";
        let startedAt = Date.now();
        let completed: CommandResult<Output> | undefined;
        const captured = await context.artifacts.capture(async (): Promise<CommandResult<Output>> => {
          try {
            return await inCommandScope(context.clientSignal, async (): Promise<CommandResult<Output>> => {
              const prepared = await spec.prepare(context, input);
              if (prepared === undefined) context.cancel();
              if (prepared === undefined || context.runSignal.aborted) {
                completed = { status: CommandStatus.Cancelled, artifacts: [] };
                return completed;
              }
              phase = "run";
              startedAt = Date.now();
              const result = await withRunSignal(context.runSignal, () => spec.run(context, prepared));
              completed = context.runSignal.aborted ? { ...result, status: CommandStatus.Cancelled } : result;
              context.artifacts.add(result.artifacts);
              if (result.status === CommandStatus.Cancelled) context.cancel();
              return completed;
            }, context.clients, { diagnostics });
          } catch (error) {
            if (nested && error instanceof CommandAbortError) {
              recordExecutionDiagnostics(diagnostics);
              throw error;
            }
            const cancelled = !(error instanceof CommandAbortError)
              && (completed ? completed.status === CommandStatus.Cancelled : phase === "run" && context.runSignal.aborted);
            if (!completed || !diagnostics.some(item => item.phase === "cleanup")) {
              diagnostics.push(executionDiagnostic(error, { phase: completed ? "cleanup" : phase, target: spec.name, startedAt, kind: cancelled ? "cancelled" : undefined }));
            }
            if (!cancelled) context.options.onError?.(error, spec.name);
            return {
              ...completed,
              status: cancelled ? CommandStatus.Cancelled : CommandStatus.Failed,
              artifacts: completed?.artifacts ?? [], error, reason: diagnosticMessage(error),
            };
          }
        });
        const value = captured.value.status === CommandStatus.Ok && diagnostics.some(item => item.phase === "cleanup")
          ? { ...captured.value, status: CommandStatus.Partial as const } : captured.value;
        return { ...value, artifacts: captured.artifacts,
          diagnostics: [...(captured.value.diagnostics ?? []), ...diagnostics] };
      };
      try {
        await spec.validate?.(input);
        const key = input.idempotencyKey?.();
        if (key === undefined) return await execute();
        const cancelledBeforeLookup = context.runSignal.aborted;
        const result = await context.runIdempotent(spec, key, execute, () => {
          useLogger().info(`[${spec.name}] 复用同一范围的采集结果（进行中则等待）`);
        });
        return cancelledBeforeLookup && result.status !== CommandStatus.Failed
          ? { ...result, status: CommandStatus.Cancelled } : result;
      } catch (error) {
        if (nested && error instanceof CommandAbortError) throw error;
        context.options.onError?.(error, spec.name);
        if (error instanceof CommandAbortError) {
          return {
            status: CommandStatus.Failed, artifacts: [], error, reason: diagnosticMessage(error),
            diagnostics: [executionDiagnostic(error, { phase: "validate", target: spec.name, startedAt: invocationStartedAt })],
          };
        }
        return {
          status: CommandStatus.Failed,
          artifacts: [], error, reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}
