import { defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { modelPerformanceAttempts, modelPerformanceSummaries } from "./detector";
import { runCollectModel } from "./index";
import type { CollectModelCliOptions, ModelDiagnosis } from "./model";
import { buildModelDiagnosisHtml } from "./render";

export type ModelInput = CommandInput & Omit<CollectModelCliOptions, CommandHostOption>;

export const modelCommand = defineCommand<ModelInput, void>({
  name: "doctor model",
  render: (context, result) => renderEvidence(context, result, {
    command: "model", title: "Model",
    render: artifact => {
      const diagnosis = context.json<ModelDiagnosis>(artifact, "diagnosis.json");
      writeEvidencePage(context, artifact, { title: "doctor model", summaryHtml: buildModelDiagnosisHtml(diagnosis, modelPerformanceSummaries(diagnosis.evidence), modelPerformanceAttempts(diagnosis.evidence)) });
    },
  }),
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.model,
  run: async (context, input) => runCollectModel(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
