import {
  prepareCommandContext,
  type CommandEnvironmentRequirements,
  type CommandProfile,
} from "../command";
import { terminalStdout } from "../terminal/output";
import type { CommandDeliveryOptions } from "./delivery";
import { resolveWorkingProfile, type WorkingProfileOptions } from "./profile";

export interface CommandSpec {
  readonly name: string;
  /** Pure command-option checks that must finish before capability or environment preparation. */
  readonly validate?: () => void | Promise<void>;
  /** Host-level requirements resolved before the command is allowed to do domain work. */
  readonly environment?: CommandEnvironmentRequirements;
}

export type CommandOptions = WorkingProfileOptions & CommandDeliveryOptions & {
  kubeconfig?: string;
  context?: string;
};

export async function prepareCommand<T = undefined>(
  spec: CommandSpec,
  opts: CommandOptions,
  printProfile: boolean,
  resolveCapabilities?: (profile: CommandProfile) => T | Promise<T>,
) {
  const resolvedProfile = resolveWorkingProfile(opts);
  if (printProfile) terminalStdout.warning(`profile: ${resolvedProfile.name}\n`);
  await spec.validate?.();
  const profile: CommandProfile = {
    name: resolvedProfile.name,
    configPath: resolvedProfile.configPath,
    value: resolvedProfile.profile,
    pluginConfig: resolvedProfile.profile.plugin?.config ?? {},
  };
  const capabilities = resolveCapabilities
    ? await resolveCapabilities(profile)
    : undefined as T;
  const context = await prepareCommandContext(opts, profile, spec.environment ?? {});
  return { context, profileName: resolvedProfile.name, capabilities };
}
