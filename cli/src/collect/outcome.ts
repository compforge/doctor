import { CommandStatus, type CommandResult } from "../command";
import type { CoverageStatus } from "./protocol";
export type CollectDeliveryStatus = "complete" | "failed";
export type CollectEvidenceStatus = "complete" | "partial" | "missing";

export interface CollectOutcome {
  delivery: CollectDeliveryStatus;
  evidence: CollectEvidenceStatus;
  exitCode: 0 | 1;
}

/**
 * collect 的退出码表达“是否形成并交付了可用诊断产物”，不要求所有证据完整。
 * partial 是带明确证据缺口的正常完成；Finding 严重度属于目标健康，不参与进程成功语义。
 * @rule 调用方必须传递三态 Coverage，不能先压成 boolean，否则全 partial 会被误判为 missing。
 */
export function evaluateCollectOutcome(
  requirements: readonly CoverageStatus[],
  delivery: CollectDeliveryStatus = "complete",
): CollectOutcome {
  const available = requirements.filter((status) => status !== "insufficient").length;
  const evidence: CollectEvidenceStatus = requirements.length === 0 || available === 0
    ? "missing"
    : requirements.every((status) => status === "sufficient")
      ? "complete"
      : "partial";
  return {
    delivery,
    evidence,
    exitCode: delivery === "complete" && evidence !== "missing" ? 0 : 1,
  };
}

/** Completion and business health remain independent; partial evidence stays visible to parents. */
export function collectCommandOutcome(outcome: CollectOutcome): CommandResult<void> {
  const status = outcome.exitCode !== 0 ? CommandStatus.Failed
    : outcome.evidence === "partial" ? CommandStatus.Partial : CommandStatus.Ok;
  return { status, output: undefined, artifacts: [] };
}
