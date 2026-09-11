import { defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { composeReports } from "../../report/model";
import type { HtmlReportOptions } from "../output/html";
import { runCollectStore } from "./index";

export type StoreInput = CommandInput & Omit<Parameters<typeof runCollectStore>[0], CommandHostOption>;

export const storeCommand = defineCommand<StoreInput, void>({
  name: "doctor store",
  render: async (context, result) => composeReports("doctor store", await Promise.all(
    [...new Set(result.artifacts.map(artifact => artifact.command))].map(command => renderEvidence(context, result, {
      command, title: command.toUpperCase(),
      render: artifact => writeEvidencePage(context, artifact, context.json<Omit<HtmlReportOptions, "profileName">>(artifact, "report-input.json")),
    })),
  )),
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.store,
  run: async (context, input) => runCollectStore(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
