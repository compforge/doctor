import { type CommandInput, defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectTenant } from "./index";

export type TenantInput = CommandInput & Omit<Parameters<typeof runCollectTenant>[0], CommandHostOption>;

/** Environment and delivery are fixed by Context; these fields define the collection scope. */
export function createTenantInput(input: Omit<TenantInput, "idempotencyKey">): TenantInput {
  return {
    ...input,
    idempotencyKey() {
      return JSON.stringify([this.namespace ?? null, this.tenantId ?? null, this.tenantName ?? null, this.tenantDirectoryService ?? null, this.tenantDirectoryPort ?? null]);
    },
  };
}

export const tenantCommand = defineCommand<TenantInput, void>({
  name: "doctor tenant",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.tenant,
  run: async (context, input) => runCollectTenant(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
