import { terminalStdout } from "../terminal/output";
import type { CommandContext, EnvironmentRequirements } from "./context";
import type { PluginCapabilityContract } from "./plugin-capability";
import { requirePluginCapabilities } from "../terminal/plugin-capability";
import { CommandStatus } from "./status";
import type { CommandResult } from "./result";
import { inCommandScope } from "./execution-scope";

type Requirement<Input, Value> = Value | ((input: Input) => Value);

export interface CommandInput {
  /** Same command/key share one execution within a Context; omit for independent calls. */
  idempotencyKey?(): string;
}

export interface CommandSpec<Input extends CommandInput, Output> {
  readonly name: string;
  readonly environment?: Requirement<Input, EnvironmentRequirements>;
  readonly plugin?: Requirement<Input, PluginCapabilityContract>;
  readonly validate?: (input: Input) => void | Promise<void>;
  run(context: CommandContext, input: Input): Promise<CommandResult<Output>>;
}

/**
 * @spec CLI and parent commands call the same checked run entry point.
 * Each invocation owns its artifacts and temporary cleanup; root resources and environment are shared.
 */
export function defineCommand<Input extends CommandInput, Output>(spec: CommandSpec<Input, Output>): CommandSpec<Input, Output> {
  return {
    ...spec,
    run: async (context, input) => {
      const execute = async () => {
        const captured = await context.artifacts.capture(async (): Promise<CommandResult<Output>> => {
          try {
            const result = await inCommandScope(context.signal, async () => {
              context.signal.throwIfAborted();
              if (spec.plugin) {
                const contract = typeof spec.plugin === "function" ? spec.plugin(input) : spec.plugin;
                requirePluginCapabilities(await context.resolvePlugin(), contract);
              }
              const environment = typeof spec.environment === "function" ? spec.environment(input) : spec.environment;
              await context.ensureEnvironment(environment ?? {});
              context.signal.throwIfAborted();
              const result = await spec.run(context, input);
              context.artifacts.include(result.artifacts);
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
    },
  };
}
