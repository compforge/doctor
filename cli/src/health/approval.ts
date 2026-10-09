import { defineCommandDecision, type CommandContext } from "../command";
import type { ApprovalDecision, ApprovalGate } from "../command/approval";
import { caseError } from "../case/http-check";
import type { PreparedCaseCheck } from "./case-prepare";
import type { CaseCheckActions } from "./cases";

const healthApproval = defineCommandDecision<ApprovalDecision>("health.case-approval");

/** @spec Approve the prepared Health scope once per CommandContext, including refusal, across Cases and consumer replicas. */
export function createHealthCaseApproval(context: CommandContext, namespace: string,
  prepared: readonly PreparedCaseCheck[], gate: ApprovalGate): CaseCheckActions["approve"] {
  const checks = prepared.flatMap(check => check.execution ? [check.execution] : []);
  const scope = [context.profile.name, namespace, ...checks.map(check => JSON.stringify([
    check.consumer.name, check.binding, check.query,
  ])).sort()];
  const consumers = [...new Set(checks.map(check => `${check.consumer.name}/${check.binding.workload}`))];
  return (target, item) => context.decide(healthApproval, scope, () => gate({
    id: "health-case", risk: "disrupt",
    title: "执行本轮 Health 的非只读 Case 检查",
    target: `${namespace}: ${consumers.join(", ")}`,
    impact: [
      ...checks.map(check => `${check.consumer.name}/${check.binding.workload} → ${check.binding.producer.service}/${check.binding.producer.source}`),
      `首个消费方实例：${target.namespace}/${target.pod}/${target.container ?? ""}`,
      `首个请求：${item.case.input.method} ${caseError(item.targets[0]!.url)}`,
      "确认覆盖上述消费关系的全部非只读 Case；可能创建会话、产生模型费用或触发所选服务的业务动作。",
      "每个绑定最多检查 10 个 Running 实例，每个实例最多 10 个 Case；单个 Case 每实例执行一次，无自动重试。",
    ],
  }));
}
