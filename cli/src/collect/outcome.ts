import { currentCommandSignal } from "../command/execution-scope";
import { CommandStatus, type CommandResult } from "../command";
import type { EvidenceStatus } from "./evidence";
export type CollectDeliveryStatus = "complete" | "failed";
export type CollectEvidenceStatus = "complete" | "partial" | "missing";

export interface CollectOutcome {
  delivery: CollectDeliveryStatus;
  evidence: CollectEvidenceStatus;
  exitCode: 0 | 1;
}

/** Requested acquisition results determine completion; Findings and row counts do not.
 * @spec Empty successful queries and unnecessary work remain successful; partial evidence is retained.
 */
export function evaluateCollectOutcome(
  requirements: readonly EvidenceStatus[],
  delivery: CollectDeliveryStatus = "complete",
): CollectOutcome {
  const requested = requirements.filter(status => status !== "unnecessary" && status !== "skipped");
  const available = requested.filter(status => status === "ok" || status === "partial").length;
  const evidence: CollectEvidenceStatus = requested.every(status => status === "ok") ? "complete"
    : available ? "partial" : "missing";
  return {
    delivery,
    evidence,
    exitCode: delivery === "complete" && evidence !== "missing" ? 0 : 1,
  };
}

/** Completion and business health remain independent; partial evidence stays visible to parents. */
export function collectCommandOutcome(outcome: CollectOutcome): CommandResult<void> {
  const status = currentCommandSignal()?.aborted ? CommandStatus.Cancelled : outcome.exitCode !== 0 ? CommandStatus.Failed
    : outcome.evidence === "partial" ? CommandStatus.Partial : CommandStatus.Ok;
  return { status, output: undefined, artifacts: [] };
}
