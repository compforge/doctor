import type { CommandInput } from "./spec";
import type { CommandContext } from "./context";

/** CLI/profile and final delivery settings do not belong to a domain command's input. */
export type CommandHostOption = "profile" | "config" | "kubeconfig" | "context" | "output" | "format";

export function domainInput<Input extends object>(options: Input): Omit<Input, CommandHostOption> & CommandInput {
  const { profile, config, kubeconfig, context, output, format, ...input } = options as Input & {
    [Key in CommandHostOption]?: unknown;
  };
  return input;
}

export function commandOptions(context: CommandContext) {
  return {
    ...context.options.environment,
    profile: context.profile.name,
    config: context.profile.configPath,
    format: context.options.format,
    output: undefined,
  };
}
