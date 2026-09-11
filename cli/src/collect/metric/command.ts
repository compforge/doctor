import { defineCommand, type CommandInput } from "../../command";
import { commandOptions, type CommandHostOption } from "../../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../../command/plugin-command-capabilities";
import { renderEvidence, writeEvidencePage } from "../../report/evidence";
import { runCollectMetric } from "./index";
import type { MetricDiagnosis, MetricRunControl } from "./model";
import { buildMetricSections, buildMetricSummary } from "./render";

export type MetricInput = CommandInput & Omit<Parameters<typeof runCollectMetric>[0], CommandHostOption> & { window?: MetricRunControl };

export const metricCommand = defineCommand<MetricInput, void>({
  name: "doctor metric",
  render: async (context, result) => renderEvidence(context, result, {
    command: "metric", title: "Metric", scope: "Service / 时间窗口",
    render: artifact => {
      const diagnosis = context.json<MetricDiagnosis>(artifact, "diagnosis.json");
      writeEvidencePage(context, artifact, { title: "doctor metric",
        summaryHtml: buildMetricSummary(diagnosis), sections: buildMetricSections(diagnosis),
      });
    },
  }),
  plugin: PLUGIN_COMMAND_CAPABILITIES.metric,
  run: (context, { window, ...input }) => runCollectMetric(
    { ...input, ...commandOptions(context) }, context.plugin, context, undefined, {
      signal: window?.signal ? AbortSignal.any([context.signal, window.signal]) : context.signal,
      onWindowStart: window?.onWindowStart,
    },
  ),
});
