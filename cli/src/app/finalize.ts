import type { CommandContext } from "../command";
import { RenderContext } from "../report/context";
import type { Report } from "../report/model";
import { deliverCommandArtifacts, type CommandDeliveryOptions } from "./delivery";
import { reportError } from "./error-log";

export interface FinalizeCommandInput {
  command: string;
  context: CommandContext;
  delivery: CommandDeliveryOptions;
  code: number;
  render?: (context: RenderContext) => Promise<Report>;
}

/** Root lifecycle boundary: release clients and deliver evidence even when cleanup fails. */
export async function finalizeCommand(input: FinalizeCommandInput): Promise<number> {
  let code = input.code;
  try { await input.context.disposeClients(); }
  catch (error) {
    reportError(error, { context: input.command, summary: "client cleanup failed" });
    code = 1;
  }
  if (input.context.signal.aborted) code = 130;
  const renderer = new RenderContext(input.context.artifacts.list(), input.context.profile.name,
    (error, command) => reportError(error, { context: command, summary: "report render failed" }));
  const wantsReport = !["json", "md"].includes(input.delivery.format?.trim() ?? "");
  const report = wantsReport && input.render ? await input.render(renderer) : undefined;
  if (renderer.failures.length && code !== 130) code = 1;
  const delivered = await deliverCommandArtifacts(
    input.context,
    input.delivery,
    code,
    input.command,
    report && { report, context: renderer, preserveArtifacts: renderer.failures.length > 0 },
  );
  return input.context.signal.aborted ? 130 : delivered ? code : 1;
}
