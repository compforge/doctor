import { prepareCommandRequirements } from "../command/prepare";
import { serializeEvidence } from "../collect/serialize";
import { CommandInputError, defineCommand, type CommandInput } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { renderEvidence } from "../report/evidence";
import { replayPerf } from "./observations";
import { runPerf } from "./index";
import type { PerfCliOpts, PerfResult } from "./model";
import { writePerfReport } from "./report";

type PerfServiceInput = CommandInput & Omit<PerfCliOpts, CommandHostOption>;
export const perfCommand = defineCommand<PerfServiceInput, PerfResult>({
  name: "doctor perf",
  validate: input => {
    if (input.from !== undefined && !input.from.trim()) throw new CommandInputError("--from 不能为空");
  },
  serialize: async (context, result) => serializeEvidence(context, result.artifacts.filter(artifact => artifact.command === "perf")),
  render: (context, result) => renderEvidence(context, result, {
    command: "perf", title: "Perf", scope: "负载 / 时间窗口",
    render: artifact => {
      if (!result.output) throw new Error("未形成 Perf 结果");
      writePerfReport({ ...result.output, outputDir: artifact.path });
      context.write(artifact, context.read(artifact, "perf.html"));
    },
  }),
  prepare: async (context, input) => {
    if (input.from) return input;
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.perf });
    return input;
  },
  run: (context, input) => input.from ? replayPerf({ ...input, ...commandOptions(context) }, context) : runPerf({ ...input, ...commandOptions(context) }, context.plugin, context),
});
