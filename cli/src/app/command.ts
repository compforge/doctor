import type { PluginDefinition } from "@compforge/doctor-plugin";
import {
  prepareCommandContext,
  type CommandContext,
  type CommandEnvironmentRequirements,
  type CommandProfile,
  type PluginCapabilityContract,
} from "../command";
import { loadActivePlugin } from "../plugin";
import { requirePluginCapabilities } from "../terminal/plugin-capability";
import { terminalStdout } from "../terminal/output";
import { reportError } from "./error-log";
import { resolveWorkingProfile, type WorkingProfileOptions } from "./profile";

export interface CommandSpec {
  readonly name: string;
  /** Pure command-option checks that must finish before capability or environment preparation. */
  readonly validate?: () => void | Promise<void>;
  /** Host-level requirements resolved before the command is allowed to do domain work. */
  readonly environment?: CommandEnvironmentRequirements;
}

type CommandOptions = WorkingProfileOptions & {
  kubeconfig?: string;
  context?: string;
};

interface PreparedCommand<T = undefined> {
  readonly context: CommandContext;
  readonly profileName: string;
  readonly capabilities: T;
}

async function prepareCommand<T = undefined>(
  spec: CommandSpec,
  opts: CommandOptions,
  printProfile: boolean,
  resolveCapabilities?: (profile: CommandProfile) => T | Promise<T>,
): Promise<PreparedCommand<T>> {
  // Configuration is parsed and structurally validated exactly once for this command.
  const resolvedProfile = resolveWorkingProfile(opts);
  if (printProfile) terminalStdout.warning(`profile: ${resolvedProfile.name}\n`);
  await spec.validate?.();
  // Capability contracts are host facts and must fail before any target connectivity probe.
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

export async function runCommand(
  spec: CommandSpec,
  opts: CommandOptions,
  action: (commandContext: CommandContext, profileName: string) => Promise<number | void>,
  printProfile = true,
): Promise<void> {
  try {
    const prepared = await prepareCommand(spec, opts, printProfile);
    const code = await action(prepared.context, prepared.profileName);
    if (typeof code === "number") process.exitCode = code;
  } catch (err) {
    reportError(err, { context: spec.name, summary: "fatal" });
    process.exitCode = 1;
  }
}

export async function runPluginCommand(
  spec: CommandSpec & { plugin: PluginCapabilityContract },
  opts: CommandOptions & { namespace?: string },
  embeddedPlugin: PluginDefinition | undefined,
  action: (
    plugin: PluginDefinition,
    commandContext: CommandContext,
    profileName: string,
  ) => Promise<number | void>,
): Promise<void> {
  let pluginIdentity: string | undefined;
  try {
    const prepared = await prepareCommand(spec, opts, true, async (profile) => {
      const selectedPlugin = embeddedPlugin ?? await loadActivePlugin();
      if (selectedPlugin) pluginIdentity = `${selectedPlugin.id}@${selectedPlugin.version}`;
      const activePlugin = requirePluginCapabilities(
        selectedPlugin,
        spec.plugin,
      );
      activePlugin.validateConfig?.(profile.pluginConfig);
      return activePlugin;
    });
    const code = await action(
      prepared.capabilities,
      prepared.context,
      prepared.profileName,
    );
    if (typeof code === "number") process.exitCode = code;
  } catch (err) {
    reportError(err, { context: spec.name, summary: "fatal", plugin: pluginIdentity });
    process.exitCode = 1;
  }
}

export async function runStandaloneCommand(
  context: string,
  action: () => Promise<number | void>,
): Promise<void> {
  try {
    const code = await action();
    if (typeof code === "number") process.exitCode = code;
  } catch (err) {
    reportError(err, { context, summary: "fatal" });
    process.exitCode = 1;
  }
}
