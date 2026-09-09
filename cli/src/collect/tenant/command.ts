import { defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectTenant } from "./index";

export type TenantInput = Omit<Parameters<typeof runCollectTenant>[0], CommandHostOption>;

export const tenantCommand = defineCommand<TenantInput, void>({
  name: "doctor tenant",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.tenant,
  run: async (context, input) => runCollectTenant(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
