export type OperationRisk = "observe" | "overhead" | "disrupt";

/**
 * 谁做的决定。`non-interactive` 与 `prompt` 必须分开——前者没有向用户提问，
 * 不能在审计记录中写成用户拒绝。
 */
export type ApprovalSource =
  | "prompt"
  | "assume-yes"
  | "gate-error"
  | "non-interactive";

export interface ApprovalDecision {
  approved: boolean;
  source: ApprovalSource;
}

/** 客观描述一次待批准的外部状态变更；领域流程仍负责实际执行。 */
export interface ApprovalRequest {
  id: string;
  risk: OperationRisk;
  title: string;
  target: string;
  impact: readonly string[];
  purpose?: string;
}

export type ApprovalGate = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export function approvalDeniedReason(source: ApprovalSource): string {
  const tail = "已取消该操作";
  switch (source) {
    case "non-interactive":
      return `非交互终端无法取得确认（可用 -y/--yes 预先批准），${tail}`;
    case "gate-error":
      return `确认环节出错，${tail}`;
    default:
      return `用户未确认，${tail}`;
  }
}

export async function approveAll(): Promise<ApprovalDecision> {
  return { approved: true, source: "assume-yes" };
}
