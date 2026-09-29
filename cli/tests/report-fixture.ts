import { strFromU8, unzipSync } from "fflate";
import type { CommandContext, CommandInput, CommandResult, Command } from "../src/command";
import { CommandStatus, commandOutcome } from "../src/command";
import { RenderContext } from "../src/report/context";
import { finalizeCommand } from "../src/app/finalize";
import { commandExitCode } from "../src/app/command";
import { serializeEvidence } from "../src/collect/serialize";
import type { CommandDeliveryOptions } from "../src/app/delivery";
import type { Report } from "../src/report/model";

export async function renderForDelivery<Input extends CommandInput, Output>(context: CommandContext,
  command: Command<Input, Output>, result: CommandResult<Output>) {
  const renderer = new RenderContext(context.artifacts.list(), "test");
  const report = await renderer.render(command, result);
  return { context: renderer, report, preserveArtifacts: renderer.failures.length > 0 };
}

/** Delivery fixtures explicitly declare their synthetic views; production never scans directories for navigation. */
export function fixtureReport(context: CommandContext) {
  const renderer = new RenderContext(context.artifacts.list(), "test");
  const artifacts = context.artifacts.list().filter(artifact => artifact.command !== "collect");
  const report: Report = { title: "doctor fixture", sections: [...new Set(artifacts.map(artifact => artifact.command))].map(command => ({
    id: command, title: command, status: CommandStatus.Ok,
    pages: artifacts.filter(artifact => artifact.command === command).map(artifact => renderer.page(artifact, {
      title: artifact.command, status: CommandStatus.Ok,
    })),
  })) };
  return { context: renderer, report };
}

export function readReport(html: string) {
  const encoded = html.match(/<template id="doctor-report-archive">([^<]+)<\/template>/)?.[1];
  if (!encoded) throw new Error("missing report archive");
  const entries = unzipSync(Buffer.from(encoded, "base64"));
  const index = JSON.parse(strFromU8(entries["index.json"]!)) as {
    version: 2; sections: Array<{ id: string; pages: Array<{ id: string; entry?: string; title: string; subject?: { key: string }; reason?: string; renderError?: string; status: CommandStatus }> }>;
  };
  return { index, entries, pages: Object.entries(entries).filter(([name]) => name.endsWith(".html")).map(([, bytes]) => strFromU8(bytes)).join("\n") };
}

export function finalizeResult<Input extends CommandInput, Output>(context: CommandContext,
  spec: Command<Input, Output>, result: CommandResult<Output>, delivery: CommandDeliveryOptions,
  commandInput: Input = { bizIds: [] } as unknown as Input): Promise<number> {
  return finalizeCommand({ context, spec, commandInput, result, delivery, code: commandExitCode(result) });
}

/** A file-delivery test declares one execution per fixture; no production command or renderer is inferred. */
export function finalizeFixture(context: CommandContext, delivery: CommandDeliveryOptions,
  code = 0, name = "doctor fixture"): Promise<number> {
  const command = name.replace(/^doctor /, "");
  const artifacts = context.artifacts.list();
  const own = artifacts.filter(artifact => artifact.command === command);
  const children = artifacts.filter(artifact => artifact.command !== command).map(artifact => ({
    spec: { name: `doctor ${artifact.command}`, serialize: async (writer: import("../src/command").SerializeContext) => serializeEvidence(writer, [artifact]) },
    result: { ...commandOutcome(code), artifacts: [artifact] },
  }));
  const result = { ...commandOutcome(code), artifacts };
  const spec: Command<CommandInput, void> = {
    name, run: async () => result,
    serialize: async writer => ({ ...serializeEvidence(writer, own),
      children: await Promise.all(children.map(child => writer.serialize(child.spec, child.result))) }),
    render: async () => fixtureReport(context).report,
  };
  return finalizeCommand({ context, spec, commandInput: {}, result, delivery, code });
}
