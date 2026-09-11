import { logCommand } from "../collect/log/command";
import { metricCommand } from "../collect/metric/command";
import { traceCommand } from "../collect/trace/command";
import { defineCommand, type CommandInput } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { renderEvidence } from "../report/evidence";
import { composeReports } from "../report/model";
import { runPerf } from "./index";
import type { PerfCliOpts, PerfResult } from "./model";
import { writePerfReport } from "./report";

export type PerfInput = CommandInput & Omit<PerfCliOpts, CommandHostOption>;
export const perfCommand = defineCommand<PerfInput, PerfResult>({
  name: "doctor perf",
  render: async (context, result) => {
    const reports = [await renderEvidence(context, result, {
      command: "perf", title: "Perf", scope: "负载 / 时间窗口",
      render: artifact => {
        if (!result.output) throw new Error("未形成 Perf 结果");
        writePerfReport(result.output);
        context.write(artifact, context.read(artifact, "perf.html"));
      },
    })];
    if (result.output) {
      reports.push(await context.render(metricCommand, result.output.metric));
      for (const sample of result.output.samples) {
        reports.push(await context.render(traceCommand, sample.trace));
        if (sample.log) reports.push(await context.render(logCommand, sample.log));
      }
    }
    return composeReports("doctor perf", reports);
  }, environment: { kubernetes: true },
  plugin: PLUGIN_COMMAND_CAPABILITIES.perf,
  run: (context, input) => runPerf({ ...input, ...commandOptions(context) }, context.plugin, context),
});
