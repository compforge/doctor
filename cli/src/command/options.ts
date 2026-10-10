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
    // Manifest and Summary are root delivery views; collectors still prepare complete Bundle evidence.
    format: ["manifest", "summary"].includes(context.options.format?.trim() ?? "") ? "bundle" : context.options.format,
    output: undefined,
  };
}
