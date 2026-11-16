import { defineCommandDecision, type CommandContext } from "../../command";
import type { ApprovalDecision, ApprovalGate } from "../../command/approval";
import { caseError } from "../../case/http-check";
import type { CaseCheckActions } from "./run";

const healthApproval = defineCommandDecision<ApprovalDecision>("health.case-approval");

/** @spec Approval covers one Case at one consumer instance, never unrelated Cases or Services. */
export function createHealthCaseApproval(context: CommandContext, namespace: string,
  gate: ApprovalGate): CaseCheckActions["approve"] {
  return (target, item, check) => {
    const scope = [context.profile.name, namespace, JSON.stringify([
      check?.scope ?? "biz", check?.consumer, check?.consumeExtension, check?.bindingId,
      target.pod, target.uid, target.container, item.case, item.subject, item.targets,
    ])];
    const readOnly = ["GET", "HEAD"].includes(item.case.input.method);
    return context.decide(healthApproval, scope, () => gate({
      id: "health-case", risk: readOnly ? "observe" : "disrupt",
      title: `${check?.scope === "deps" ? "依赖访问检查" : "业务检查"}：${item.case.id}${item.subject ? ` · ${item.subject.label ?? item.subject.id}` : ""}`,
      target: `${check?.consumer ?? target.workload} / ${target.namespace}/${target.pod}/${target.container ?? ""}`,
      impact: [
        ...item.targets.map(endpoint => `${item.case.input.method} ${caseError(endpoint.url)}`),
        readOnly ? "从上述实例读取并验证响应。" : "执行该项请求，可能创建会话、产生模型费用或触发业务动作。",
        "本次确认仅覆盖当前 Case 在上述实例的请求，不批准其他检查。",
      ],
    }));
  };
}
