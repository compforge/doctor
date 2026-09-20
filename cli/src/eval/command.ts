import { prepareCommandRequirements } from "../command/prepare";
import { serializeEvidence } from "../collect/serialize";
import { dataCommand } from "../collect/data/command";
import { logCommand } from "../collect/log/command";
import { traceCommand } from "../collect/trace/command";
import { defineCommand, type CommandInput } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import { PLUGIN_COMMAND_CAPABILITIES } from "../command/plugin-command-capabilities";
import { renderEvidence } from "../report/evidence";
import { composeReports } from "../report/model";
import { runEval } from "./index";
import type { EvalCliOpts, EvalRun } from "./model";
import { writeEvalReport } from "./output";

export type EvalInput = CommandInput & Omit<EvalCliOpts, CommandHostOption>;
export const evalCommand = defineCommand<EvalInput, EvalRun>({
  name: "doctor eval",
  serialize: async (context, result) => {
    const children = [];
    const evidence = result.output?.evidence;
    if (evidence?.trace.result) children.push(await context.serialize(traceCommand, evidence.trace.result));
    if (evidence?.log.result) children.push(await context.serialize(logCommand, evidence.log.result));
    if (evidence?.data.result) children.push(await context.serialize(dataCommand, evidence.data.result));
    const own = serializeEvidence(context, result.artifacts.filter(artifact => artifact.command === "eval"));
    return { ...own, children };
  },
  render: async (context, result) => {
    const reports = [await renderEvidence(context, result, {
      command: "eval", title: "Eval", scope: "CaseSet",
      render: artifact => writeEvalReport(artifact.path, context.json<EvalRun>(artifact, "run.json"), context.profileName),
    })];
    const evidence = result.output?.evidence;
    if (evidence?.trace.result) reports.push(await context.render(traceCommand, evidence.trace.result));
    if (evidence?.log.result) reports.push(await context.render(logCommand, evidence.log.result));
    if (evidence?.data.result) reports.push(await context.render(dataCommand, evidence.data.result));
    return composeReports("doctor eval", reports);
  },
  prepare: async (context, input) => {
    await prepareCommandRequirements(context, { plugin: PLUGIN_COMMAND_CAPABILITIES.eval, environment: { kubernetes: true } });
    return input;
  },
  run: (context, input) => runEval({ ...input, ...commandOptions(context) }, context.plugin, context),
});
