import { terminalStdout } from "../terminal/output";
import { requirePluginCapabilities } from "../terminal/plugin-capability";
import type { CommandContext, EnvironmentRequirements } from "./context";
import { inCommandScope } from "./execution-scope";
import type { PluginCapabilityContract } from "./plugin-capability";
import type { CommandResult } from "./result";
import { CommandStatus } from "./status";
import { withInteractionOptions } from "../terminal/policy";

import type { RenderContext } from "../report/context";
import type { Report } from "../report/model";
import type { SerializeContext } from "./serialization/context";
import type { SerializedOutput } from "./serialization/model";

type Requirement<Input, Value> = Value | ((input: Input) => Value);

export interface CommandInput {
  yes?: boolean;
  /** Same command/key share one execution within a Context; omit for independent calls. */
  idempotencyKey?(): string;
}

export interface CommandSpec<Input extends CommandInput, Output, Prepared = Input> {
  readonly name: string;
  readonly environment?: Requirement<Input, EnvironmentRequirements>;
  readonly plugin?: Requirement<Input, PluginCapabilityContract | undefined>;
  readonly validate?: (input: Input) => void | Promise<void>;
  /** Select and bind this invocation's resources/capabilities; undefined cancels before execution. */
  prepare?(context: CommandContext, input: Input): Promise<Prepared | undefined>;
  run(context: CommandContext, prepared: Prepared): Promise<CommandResult<Output>>;
  /** Root finalize persists local results before rendering. No collection or remote access. */
  serialize?(context: SerializeContext, result: CommandResult<Output>): Promise<SerializedOutput>;
  /** Root finalize renders local results. Commands without a report (for example chat) omit this hook. */
  render?(context: RenderContext, result: CommandResult<Output>): Promise<Report>;
}

/** Public calls always take Input; preparation is owned by the checked entry point. */
export type Command<Input extends CommandInput, Output> = Omit<CommandSpec<Input, Output>, "prepare">;

type UnpreparedSpec<Input extends CommandInput, Output> = CommandSpec<Input, Output> & { prepare?: never };
type PreparedSpec<Input extends CommandInput, Output, Prepared> = CommandSpec<Input, Output, Prepared>
  & Required<Pick<CommandSpec<Input, Output, Prepared>, "prepare">>;

/**
 * @spec CLI and parent commands call the same checked run entry point.
 * @spec Prepare and run share one invocation scope and one idempotency decision; only ready work runs.
 * Each invocation owns its artifacts and temporary cleanup; root resources and environment are shared.
 */
export function defineCommand<Input extends CommandInput, Output>(spec: UnpreparedSpec<Input, Output>): Command<Input, Output>;
export function defineCommand<Input extends CommandInput, Output, Prepared>(spec: PreparedSpec<Input, Output, Prepared>): Command<Input, Output>;
export function defineCommand<Input extends CommandInput, Output, Prepared>(
  spec: UnpreparedSpec<Input, Output> | PreparedSpec<Input, Output, Prepared>,
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
              if (spec.plugin) {
                const contract = typeof spec.plugin === "function" ? spec.plugin(input) : spec.plugin;
                if (contract) requirePluginCapabilities(await context.resolvePlugin(), contract);
              }
              const environment = typeof spec.environment === "function" ? spec.environment(input) : spec.environment;
              await context.ensureEnvironment(environment ?? {});
              context.signal.throwIfAborted();
              let result: CommandResult<Output>;
              if (spec.prepare) {
                const prepared = await spec.prepare(context, input);
                context.signal.throwIfAborted();
                if (prepared === undefined) {
                  context.cancel();
                  return { status: CommandStatus.Cancelled, artifacts: [] };
                }
                result = await spec.run(context, prepared);
              } else {
                result = await spec.run(context, input);
              }
              context.artifacts.add(result.artifacts);
              if (result.reportName) context.artifacts.setReportName(result.reportName);
              if (result.status === CommandStatus.Cancelled) context.cancel();
              return result;
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
          terminalStdout.write(`[${spec.name}] 复用同一范围的采集结果（进行中则等待）\n`);
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
