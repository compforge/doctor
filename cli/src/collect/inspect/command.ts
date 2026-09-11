import { defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { runCollectInspect } from "./index";
import type { InspectDiagnosis } from "./model";
import { buildInspectHtml, buildInspectHtmlSections } from "./render";

export type InspectInput = CommandInput & Omit<Parameters<typeof runCollectInspect>[0], CommandHostOption>;

/** Environment and delivery are fixed by Context; these fields define the collection scope. */
export function createInspectInput(input: Omit<InspectInput, "idempotencyKey">): InspectInput {
  return {
    ...input,
    idempotencyKey() {
      return JSON.stringify([this.namespace ?? null, this.services ?? null, this.deploymentConfig ?? null, this.dependencies ?? null]);
    },
  };
}

export const inspectCommand = defineCommand<InspectInput, void>({
  name: "doctor inspect",
  render: async (context, result) => renderEvidence(context, result, {
    command: "inspect", title: "Inspect", scope: "环境 / Service",
    render: artifact => {
      const diagnosis = context.json<InspectDiagnosis>(artifact, "diagnosis.json");
      writeEvidencePage(context, artifact, { title: "doctor inspect",
        summaryHtml: buildInspectHtml(diagnosis), sections: buildInspectHtmlSections(diagnosis),
      });
    },
  }),
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.inspect,
  run: async (context, input) => runCollectInspect(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
