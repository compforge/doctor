import type { CommandInput } from "./spec";
import type { CommandContext } from "./context";
import { assumesYes } from "../terminal/policy";

/** CLI/profile and final delivery settings do not belong to a domain command's input. */
export type CommandHostOption = "profile" | "config" | "kubeconfig" | "context" | "output" | "format" | "debug" | "version" | "distribution";

export function domainInput<Input extends object>(options: Input): Omit<Input, CommandHostOption> & CommandInput {
  const { profile, config, kubeconfig, context, output, format, debug, version, distribution, ...input } = options as Input & {
    [Key in CommandHostOption]?: unknown;
  };
  return input;
}

export function commandOptions(context: CommandContext) {
  return {
    yes: assumesYes(),
    ...context.options.environment,
    profile: context.profile.configPath ? context.profile.name : undefined,
    config: context.profile.configPath,
    // Manifest is a root delivery format: collectors prepare ordinary Bundle evidence, not HTML.
    format: context.options.format?.trim() === "manifest" ? "bundle" : context.options.format,
    output: undefined,
  };
}
