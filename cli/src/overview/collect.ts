import type { CommandContext, CommandResult } from "../command";
import { collectCommand, type CollectInput, type CollectOutput } from "../collect/composite";

import { useLogger } from "../terminal/log";

/** Keep the selected set intact so domain commands can merge source reads and queries. */
export async function collectOverviewSamples(
  context: CommandContext, bizIds: readonly string[], input: Omit<CollectInput, "bizIds">, concurrency: number,
  run: typeof collectCommand.run = collectCommand.run,
): Promise<CommandResult<CollectOutput>> {
  useLogger("overview:collect").warn(`批量采集 ${bizIds.length} 个 biz-id`);
  const result = await run(context, { ...input, bizIds: [...new Set(bizIds)], itemConcurrency: concurrency });
  context.artifacts.add(result.artifacts);
  return result;
}
