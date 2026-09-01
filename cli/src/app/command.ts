import type { PluginDefinition } from "@compforge/doctor-plugin";
import {
  type CommandContext,
  type PluginCapabilityContract,
} from "../command";
import { loadActivePlugin } from "../plugin";
import { requirePluginCapabilities } from "../terminal/plugin-capability";
import { reportError } from "./error-log";
import { finalizeCommand } from "./finalize";
import { prepareCommand, type CommandOptions, type CommandSpec } from "./prepare";

export type { CommandSpec } from "./prepare";

export async function runCommand(
  spec: CommandSpec,
  opts: CommandOptions,
  work: (commandContext: CommandContext, profileName: string) => Promise<number | void>,
  printProfile = true,
): Promise<void> {
  try {
    const { context, profileName } = await prepareCommand(spec, opts, printProfile);
    let code: number | void;
    try {
      code = await work(context, profileName);
    } catch (err) {
      reportError(err, { context: spec.name, summary: "fatal" });
      code = 1;
    }
    const commandCode = typeof code === "number" ? code : 0;
    const finalCode = await finalizeCommand({
      command: spec.name,
      context,
      delivery: opts,
      code: commandCode,
    });
    if (typeof code === "number" || finalCode !== 0) process.exitCode = finalCode;
  } catch (err) {
    reportError(err, { context: spec.name, summary: "fatal" });
    process.exitCode = 1;
  }
}

export async function runPluginCommand(
  spec: CommandSpec & { plugin: PluginCapabilityContract },
  opts: CommandOptions & { namespace?: string },
  embeddedPlugin: PluginDefinition | undefined,
  work: (
    plugin: PluginDefinition,
    commandContext: CommandContext,
    profileName: string,
  ) => Promise<number | void>,
): Promise<void> {
  let pluginIdentity: string | undefined;
  try {
    const { context, profileName, capabilities } = await prepareCommand(spec, opts, true, async (profile) => {
      const selectedPlugin = embeddedPlugin ?? await loadActivePlugin();
      if (selectedPlugin) pluginIdentity = `${selectedPlugin.id}@${selectedPlugin.version}`;
      const activePlugin = requirePluginCapabilities(
        selectedPlugin,
        spec.plugin,
      );
      activePlugin.validateConfig?.(profile.pluginConfig);
      return activePlugin;
    });
    context.registerPluginServices(
      capabilities.id,
      capabilities.services.services.map((service) => service.name),
    );
    const code = await work(
      capabilities,
      context,
      profileName,
    ).catch((err) => {
      reportError(err, { context: spec.name, summary: "fatal", plugin: pluginIdentity });
      return 1;
    });
    const commandCode = typeof code === "number" ? code : 0;
    const finalCode = await finalizeCommand({
      command: spec.name,
      context,
      delivery: opts,
      code: commandCode,
    });
    if (typeof code === "number" || finalCode !== 0) process.exitCode = finalCode;
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
