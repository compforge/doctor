import type { CommandContext } from "../command";
import { deliverCommandArtifacts, type CommandDeliveryOptions } from "./delivery";

export interface FinalizeCommandInput {
  command: string;
  context: CommandContext;
  delivery: CommandDeliveryOptions;
  code: number;
}

/** Stable command lifecycle boundary for delivery and future global closing work. */
export async function finalizeCommand(input: FinalizeCommandInput): Promise<number> {
  const delivered = await deliverCommandArtifacts(
    input.context,
    input.delivery,
    input.code,
    input.command,
  );
  return delivered ? input.code : 1;
}
