import { reportError } from "./error-log";
import type { CommandContext } from "../command";
import { deliverCommandArtifacts, type CommandDeliveryOptions } from "./delivery";

export interface FinalizeCommandInput {
  command: string;
  context: CommandContext;
  delivery: CommandDeliveryOptions;
  code: number;
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
  const delivered = await deliverCommandArtifacts(
    input.context,
    input.delivery,
    code,
    input.command,
  );
  return delivered ? code : 1;
}
