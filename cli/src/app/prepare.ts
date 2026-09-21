import type { PluginDefinition } from "@compforge/doctor-plugin";
import { reportError } from "./error-report";
import { withoutShadowedDefaults } from "./option-sources";
import { CommandContext } from "../command";
import { loadActivePlugin } from "../plugin";

import { useLogger } from "../terminal/log";
import type { CommandDeliveryOptions } from "./delivery";
import { resolveWorkingProfile, type WorkingProfileOptions } from "./profile";

export type CommandOptions = WorkingProfileOptions & CommandDeliveryOptions & {
  yes?: boolean;
  kubeconfig?: string;
  context?: string;
  namespace?: string;
};

/** Only the root resolves profile and host settings; each spec prepares its own requirements. */
export function prepareCommand(opts: CommandOptions, printProfile: boolean, plugin?: PluginDefinition): CommandContext {
  const resolved = resolveWorkingProfile(opts);
  opts = withoutShadowedDefaults(opts, resolved.profile);
  if (printProfile && resolved.configPath) useLogger().info(`profile: ${resolved.name}`);
  const context = new CommandContext({}, {
    name: resolved.name, configPath: resolved.configPath, value: resolved.profile,
    pluginConfig: resolved.profile.plugin?.config ?? {},
  }, {
    plugin, loadPlugin: loadActivePlugin,
    environment: { kubeconfig: opts.kubeconfig, context: opts.context },
    format: opts.format, output: opts.output, yes: opts.yes,
    onError: (error, command) => reportError(error, { context: command, summary: "fatal", plugin: context.pluginIdentity }),
  });
  return context;
}
