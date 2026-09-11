import { defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { runCollectMcp } from "./index";
import type { McpDiagnosis } from "./model";
import { buildMcpReportHtml } from "./render";

export type McpInput = CommandInput & Omit<Parameters<typeof runCollectMcp>[0], CommandHostOption>;

export const mcpCommand = defineCommand<McpInput, void>({
  name: "doctor mcp",
  render: (context, result) => renderEvidence(context, result, {
    command: "mcp", title: "MCP",
    render: artifact => {
      const diagnosis = context.json<McpDiagnosis>(artifact, "diagnosis.json");
      writeEvidencePage(context, artifact, { title: "doctor mcp", summaryHtml: buildMcpReportHtml(diagnosis) });
    },
  }),
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.mcp,
  run: async (context, input) => runCollectMcp(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
