import { defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectStore } from "./index";

export type StoreInput = Omit<Parameters<typeof runCollectStore>[0], CommandHostOption>;

export const storeCommand = defineCommand<StoreInput, void>({
  name: "doctor store",
  environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.store,
  run: async (context, input) => runCollectStore(
    { ...input, ...commandOptions(context) }, context.plugin, context,
  ),
});
