import { defineCommand } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { runCollectMetric } from "./index";
import type { MetricRunControl } from "./model";

export type MetricInput = Omit<Parameters<typeof runCollectMetric>[0], CommandHostOption> & { window?: MetricRunControl };

export const metricCommand = defineCommand<MetricInput, void>({
  name: "doctor metric",
  plugin: PLUGIN_COMMAND_CAPABILITIES.metric,
  run: (context, { window, ...input }) => runCollectMetric(
    { ...input, ...commandOptions(context) }, context.plugin, context, undefined, {
      signal: window?.signal ? AbortSignal.any([context.signal, window.signal]) : context.signal,
      onWindowStart: window?.onWindowStart,
    },
  ),
});
