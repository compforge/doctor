import { useLogger } from "../terminal/log";
import type { CommandContext } from "./context";
import { inCommandScope } from "./execution-scope";
import type { CommandResult } from "./result";
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
  /** Check requirements and bind this invocation's selection; undefined cancels before execution. */
  prepare(context: CommandContext, input: Input): Promise<Prepared | undefined>;
  run(context: CommandContext, prepared: Prepared): Promise<CommandResult<Output>>;
  /** Derive the default delivered report name from the invocation input (see
   *  command/report-name.ts for the unified convention). Used when the result does not
   *  set its own reportName — including the cancelled-before-run path, where the input
   *  is the only thing known. */
  reportName?(input: Input, now: Date): string;
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
 * Each invocation owns its artifacts and temporary cleanup; root resources and environment are shared.
 */
export function defineCommand<Input extends CommandInput, Output, Prepared = Input>(
  spec: CommandSpec<Input, Output, Prepared>,
): Command<Input, Output> {
  const { prepare: _prepare, run: _run, ...metadata } = spec;
  return {
    ...metadata,
    run: (context, input) => withInteractionOptions({ yes: input.yes ?? context.options.yes }, async (): Promise<CommandResult<Output>> => {
      const execute = async () => {
        const captured = await context.artifacts.capture(async (): Promise<CommandResult<Output>> => {
          try {
            const result = await inCommandScope(context.signal, async (): Promise<CommandResult<Output>> => {
              context.signal.throwIfAborted();
              const prepared = await spec.prepare(context, input);
              context.signal.throwIfAborted();
              if (prepared === undefined) {
                context.cancel();
                // prepare 取消时 run 不会执行，result.reportName 无从产生；用 spec 的
                // input → name 策略补上，否则裸 doctor-<command>.html 会挡住后续同名交付。
                const reportName = spec.reportName?.(input, new Date());
                if (reportName) context.artifacts.setReportName(reportName);
                return { status: CommandStatus.Cancelled, artifacts: [], reportName };
              }
              const result = await spec.run(context, prepared);
              context.artifacts.add(result.artifacts);
              const reportName = result.reportName ?? spec.reportName?.(input, new Date());
              if (reportName) context.artifacts.setReportName(reportName);
              if (result.status === CommandStatus.Cancelled) context.cancel();
              return reportName === result.reportName ? result : { ...result, reportName };
            }, context.clients);
            return context.signal.aborted ? { ...result, status: CommandStatus.Cancelled } : result;
          } catch (error) {
            if (!context.signal.aborted) context.options.onError?.(error, spec.name);
            return {
              status: context.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed,
              artifacts: [], error, reason: error instanceof Error ? error.message : String(error),
            };
          }
        });
        return { ...captured.value, artifacts: captured.artifacts, reportName: captured.reportName };
      };
      try {
        context.signal.throwIfAborted();
        await spec.validate?.(input);
        const key = input.idempotencyKey?.();
        const result = key === undefined ? await execute() : await context.runIdempotent(spec, key, execute, () => {
          useLogger().info(`[${spec.name}] 复用同一范围的采集结果（进行中则等待）`);
        });
        return context.signal.aborted ? { ...result, status: CommandStatus.Cancelled } : result;
      } catch (error) {
        if (!context.signal.aborted) context.options.onError?.(error, spec.name);
        return {
          status: context.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed,
          artifacts: [], error, reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}
