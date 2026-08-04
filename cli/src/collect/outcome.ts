export type CollectDeliveryStatus = "complete" | "failed";
export type CollectEvidenceStatus = "complete" | "partial" | "missing";

export interface CollectOutcome {
  delivery: CollectDeliveryStatus;
  evidence: CollectEvidenceStatus;
  exitCode: 0 | 1;
}

/**
 * collect 的退出码只表达“要求的证据是否完整取得且产物是否交付成功”。
 * Finding 严重度属于诊断结果，不参与进程成功语义。
 */
export function evaluateCollectOutcome(
  requirements: readonly boolean[],
  delivery: CollectDeliveryStatus = "complete",
): CollectOutcome {
  const satisfied = requirements.filter(Boolean).length;
  const evidence: CollectEvidenceStatus = requirements.length === 0 || satisfied === 0
    ? "missing"
    : satisfied === requirements.length
      ? "complete"
      : "partial";
  return {
    delivery,
    evidence,
    exitCode: delivery === "complete" && evidence === "complete" ? 0 : 1,
  };
}
