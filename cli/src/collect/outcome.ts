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
    exitCode: delivery === "complete" && evidence !== "missing" ? 0 : 1,
  };
}
