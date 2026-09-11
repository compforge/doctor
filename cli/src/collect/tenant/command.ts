import { defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { runCollectTenant } from "./index";
import type { TenantDiagnosis } from "./model";
import { buildTenantHtml, buildTenantHtmlSections } from "./render";

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
  render: async (context, result) => renderEvidence(context, result, {
    command: "tenant", title: "Tenant", scope: "租户",
    render: artifact => {
      const diagnosis = context.json<TenantDiagnosis>(artifact, "diagnosis.json");
      writeEvidencePage(context, artifact, { title: "doctor tenant",
        summaryHtml: buildTenantHtml(diagnosis), sections: buildTenantHtmlSections(diagnosis),
      });
    },
  }),
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.tenant,
  run: async (context, input) => runCollectTenant(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
