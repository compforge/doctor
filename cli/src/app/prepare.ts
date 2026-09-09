import type { PluginDefinition } from "@compforge/doctor-plugin";
import { reportError } from "./error-log";
import { CommandContext } from "../command";
import { loadActivePlugin } from "../plugin";
import { terminalStdout } from "../terminal/output";
import type { CommandDeliveryOptions } from "./delivery";
import { resolveWorkingProfile, type WorkingProfileOptions } from "./profile";

export type CommandOptions = WorkingProfileOptions & CommandDeliveryOptions & {
  kubeconfig?: string;
  context?: string;
};

/** Only the root resolves profile and host settings; each spec prepares its own requirements. */
export function prepareCommand(opts: CommandOptions, printProfile: boolean, plugin?: PluginDefinition): CommandContext {
  const resolved = resolveWorkingProfile(opts);
  if (printProfile) terminalStdout.warning(`profile: ${resolved.name}\n`);
  const context = new CommandContext({}, {
    name: resolved.name, configPath: resolved.configPath, value: resolved.profile,
    pluginConfig: resolved.profile.plugin?.config ?? {},
  }, {
    plugin, loadPlugin: loadActivePlugin,
    environment: { kubeconfig: opts.kubeconfig, context: opts.context },
    format: opts.format, output: opts.output,
    onError: (error, command) => reportError(error, { context: command, summary: "fatal", plugin: context.pluginIdentity }),
  });
  return context;
}
