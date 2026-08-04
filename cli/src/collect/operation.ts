import type { EvidenceBundle, StepRisk } from "./evidence";
import type { InspectionMode } from "./inspection";
import {
  approvalDeniedReason,
  type ApprovalDecision,
  type ApprovalGate,
} from "../command/approval";

/** Operation 执行时会留下的步骤；未执行时按 skipped 记账，保证"为什么没做"在 manifest 里有据可查。 */
export interface StepDecl {
  id: string;
  title: string;
  risk: StepRisk;
}

/**
 * Operation 只描述一个需要用户同意的副作用，不执行它。
 *
 * 执行留在各 probe。现有三个 op 的形状互不相同——provision 是返回 path 的工厂、
 * ephemeral 是创建资源、runtime-rollout 是带 finally 的 bracket。尤其 rollout 的
 * 原始配置恢复靠 try/finally 保证，若抽成 Operation.execute()/cleanup()，就把语言级
 * 保证降级成了调用方纪律——对一个改生产 Deployment 的操作，这是安全倒退。
 *
 * 三者共享的只有"要被 mode 门禁、要问用户、要审计留痕、被拒时要记账"。所以这里只有
 * 数据，行为在 authorize/decline —— 不要给这个接口加方法。
 */
export interface Operation {
  id: string;
  /** 本操作的副作用等级。高于当前 mode 时没有询问余地，直接 decline。 */
  risk: StepRisk;
  title: string;
  /** 副作用落在谁身上。参与审批缓存 key——同一个 op 打到不同目标是两件事，要分别确认。 */
  target: string;
  impact: readonly string[];
  steps: readonly StepDecl[];
}

/**
 * authorize/decline 需要的最小切片。各 command 的 context 结构化满足它即可，
 * 共享层因此不必反向依赖任何具体 command。
 */
export interface ApprovalContext {
  mode: InspectionMode;
  bundle: EvidenceBundle;
  approvalGate: ApprovalGate;
  /** key `${op.id}@${op.target}`。同意与拒绝都缓存——同一件事重复问就是纠缠。 */
  approvals: Map<string, ApprovalDecision>;
}

export type AuthorizeResult =
  | { approved: true }
  | { approved: false; reason: string };

const RISK_ORDER: Record<StepRisk, number> = { observe: 0, overhead: 1, disrupt: 2 };

/** mode 是本次允许的最高副作用等级；op 超过它就不该惊动用户。 */
function withinMode(risk: StepRisk, mode: InspectionMode): boolean {
  return RISK_ORDER[risk] <= RISK_ORDER[mode];
}

/** 不执行该 operation：其自身步骤统一按 skipped 记账。领域原因（facts 不允许等）走这里。 */
export function decline(ctx: Pick<ApprovalContext, "bundle">, op: Operation, reason: string): void {
  for (const step of op.steps) {
    ctx.bundle.addStep({
      id: step.id,
      title: step.title,
      risk: step.risk,
      status: "skipped",
      reason,
    });
  }
}

/**
 * 取得执行该 operation 的许可：mode 门禁 → 审批缓存 → 询问用户。
 * 任一环拒绝都会顺带 decline（把 op.steps 记成 skipped），调用方只看返回值即可。
 *
 * 缓存命中时不重复记账：首次调用已经把 steps 标好了。
 */
export async function authorize(
  ctx: ApprovalContext,
  op: Operation,
  purpose?: string,
): Promise<AuthorizeResult> {
  if (!withinMode(op.risk, ctx.mode)) {
    const reason = `mode=${ctx.mode} 不允许 ${op.risk} 操作：${op.title}`;
    // 已知且有意：mode 门禁的 decline 不进审批缓存（缓存只存 gate 决定）。mode 一次 collect
    // 内不变，同一 op 反复走到这里说明调用方漏了 mode 预过滤（各 probe 本应自带 mode 分支，
    // 各 probe 本应自带 mode 预过滤；重复的 skipped 记账会把这个漏洞在 manifest 里
    // 暴露成响的，而不是被缓存悄悄吞掉。
    decline(ctx, op, reason);
    return { approved: false, reason };
  }

  const key = `${op.id}@${op.target}`;
  const cached = ctx.approvals.get(key);
  if (cached) {
    // 缓存里存着 source，所以复用时的归因跟首次一致——不会把 gate 出错说成用户拒绝。
    return cached.approved
      ? { approved: true }
      : { approved: false, reason: approvalDeniedReason(cached.source) };
  }

  let decision: ApprovalDecision;
  try {
    decision = await ctx.approvalGate({
      id: op.id,
      risk: op.risk,
      title: op.title,
      target: op.target,
      impact: op.impact,
      purpose,
    });
  } catch {
    decision = { approved: false, source: "gate-error" };
  }
  ctx.approvals.set(key, decision);
  const reason = decision.approved ? undefined : approvalDeniedReason(decision.source);

  ctx.bundle.addStep({
    id: `approval-${op.id}`,
    title: `确认：${op.title}`,
    // 询问本身没有副作用；被批准动作的等级在 output 的 risk= 里，不要拿它当本步 risk。
    risk: "observe",
    status: decision.approved ? "ok" : "skipped",
    reason,
    output: [
      `approval_source=${decision.source}`,
      `operation=${op.id}`,
      `risk=${op.risk}`,
      `target=${op.target}`,
      ...(purpose ? [`purpose=${purpose}`] : []),
      ...op.impact.map((item) => `impact=${item}`),
    ].join("\n"),
  });

  if (!decision.approved) {
    decline(ctx, op, reason!);
    return { approved: false, reason: reason! };
  }
  return { approved: true };
}
