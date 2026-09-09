import { defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectMcp } from "./index";

export type McpInput = Omit<Parameters<typeof runCollectMcp>[0], CommandHostOption>;

export const mcpCommand = defineCommand<McpInput, void>({
  name: "doctor mcp",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.mcp,
  run: async (context, input) => runCollectMcp(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
