import { ConcurrencyPool } from "@compforge/doctor-toolkit/concurrency";
import { aggregateCommandStatus, CommandStatus, type CommandContext, type CommandResult } from "../command";
import { collectCommand, type CollectInput } from "../collect/composite";
import { terminalStdout } from "../terminal/output";

/** Per-request collects share Context limits; child scopes own their evidence and cleanup. */
export async function collectOverviewSamples(
  context: CommandContext, bizIds: readonly string[], input: Omit<CollectInput, "bizIds">, concurrency: number,
  run: typeof collectCommand.run = collectCommand.run,
): Promise<CommandResult<void>> {
  const pool = new ConcurrencyPool(concurrency);
  const results = await Promise.all(bizIds.map((bizId, index) => pool.run(async () => {
    terminalStdout.warning(`\n[overview:collect] [${index + 1}/${bizIds.length}] biz-id: ${bizId}\n`);
    const result = await run(context, { ...input, bizIds: [bizId] });
    terminalStdout.write(`[overview:collect] ${bizId}: ${result.status}\n`);
    return result;
  }, context.signal).catch((error): CommandResult<void> => ({
    status: context.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed,
    artifacts: [], error, reason: error instanceof Error ? error.message : String(error),
  }))));
  // Include in input order after every in-flight command has released its resources.
  for (const result of results) context.artifacts.include(result.artifacts);
  const reason = results.flatMap((result, index) => "reason" in result && result.reason ? [`${bizIds[index]}: ${result.reason}`] : []).join("; ");
  return { status: aggregateCommandStatus(results.map((result) => result.status)), output: undefined,
    artifacts: context.artifacts.list(), ...(reason ? { reason } : {}) };
}
