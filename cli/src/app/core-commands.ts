import { runCollectCpu } from "../collect/cpu";
import { runCollectHttp } from "../collect/http";
import { runCollectMemory, runCollectMemoryAnalysis } from "../collect/memory";
import { runCollectNetwork } from "../collect/network";
import type { HtmlReportOptions } from "../collect/output/html";
import { commandOutcome, defineCommand, type CommandInput } from "../command";
import { commandOptions, type CommandHostOption } from "../command/options";
import type { CliFlags } from "../protocol";
import { runDebug } from "../provision/debug";
import { runDoctorImage } from "../provision/image";
import { runInstall, validateInstallOptions } from "../provision/install";
import { renderEvidence, writeEvidencePage } from "../report/evidence";
import { runRepl } from "./repl";

export const chatCommand = defineCommand<CommandInput & Omit<CliFlags, CommandHostOption>, void>({
  name: "doctor chat",
  run: async (context, input) => commandOutcome(await runRepl(
    { ...input, ...commandOptions(context) }, await context.resolvePlugin(), context,
  )),
});

export type ImageInput = CommandInput & Omit<Parameters<typeof runDoctorImage>[1], CommandHostOption> & { image?: string };
export const imageCommand = defineCommand<ImageInput, void>({
  name: "doctor image",
  environment: (input) => ({ kubernetes: Boolean(input.registry || input.image || !input.host) }),
  run: async (context, input) => commandOutcome(await runDoctorImage(input.image, {
    ...input, ...commandOptions(context),
  }, context)),
});

export const debugCommand = defineCommand<CommandInput & Omit<Parameters<typeof runDebug>[0], CommandHostOption>, void>({
  name: "doctor debug",
  environment: { kubernetes: true },
  run: async (context, input) => commandOutcome(await runDebug({ ...input, ...commandOptions(context) }, context)),
});

export const installCommand = defineCommand<CommandInput & Omit<Parameters<typeof runInstall>[0], Exclude<CommandHostOption, "format">>, void>({
  name: "doctor install",
  environment: { kubernetes: true },
  validate: validateInstallOptions,
  run: async (context, input) => commandOutcome(await runInstall({ ...commandOptions(context), ...input, output: context.options.output }, context)),
});

export const memCommand = defineCommand<CommandInput & Omit<Parameters<typeof runCollectMemory>[0], CommandHostOption>, void>({
  name: "doctor mem",
  environment: { kubernetes: true },
  run: async (context, input) => commandOutcome(await runCollectMemory({ ...input, ...commandOptions(context), output: context.options.output }, context)),
});

export const memaCommand = defineCommand<CommandInput & Omit<Parameters<typeof runCollectMemoryAnalysis>[0], CommandHostOption>, void>({
  name: "doctor mema",
  run: async (context, input) => commandOutcome(await runCollectMemoryAnalysis({ ...input, ...commandOptions(context), output: context.options.output }, context)),
});

export const cpuCommand = defineCommand<CommandInput & Omit<Parameters<typeof runCollectCpu>[0], CommandHostOption>, void>({
  name: "doctor cpu",
  environment: { kubernetes: true },
  run: async (context, input) => commandOutcome(await runCollectCpu({ ...input, ...commandOptions(context) }, context)),
});

export const httpCommand = defineCommand<CommandInput & Omit<Parameters<typeof runCollectHttp>[0], CommandHostOption>, void>({
  name: "doctor http",
  render: (context, result) => renderEvidence(context, result, {
    command: "http", title: "HTTP",
    render: artifact => writeEvidencePage(context, artifact, context.json<HtmlReportOptions>(artifact, "report-input.json")),
  }),
  run: async (context, input) => commandOutcome(await runCollectHttp({ ...input, ...commandOptions(context) }, context)),
});

export const netCommand = defineCommand<CommandInput & Omit<Parameters<typeof runCollectNetwork>[0], CommandHostOption>, void>({
  name: "doctor net",
  environment: { kubernetes: true },
  run: async (context, input) => commandOutcome(await runCollectNetwork({ ...input, ...commandOptions(context) }, context)),
});
