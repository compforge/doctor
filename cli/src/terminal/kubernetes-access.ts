import {
  accessLabel,
  inspectKubernetesChannel,
  kubernetesResultDetail,
  type KubernetesAccessContract,
  type KubernetesAccessEvaluation,
  type KubernetesAccessContext,
} from "../infra/k8s/access";
import type { Executor } from "../infra/k8s/executor";
import type { CommandContext } from "../command";
import { terminalStdout } from "./output";

export async function requireKubernetesChannel(input: {
  executor: Executor;
  profileName: string;
  kubeconfigSource: string;
  namespace?: string;
  commandContext?: CommandContext;
}): Promise<void> {
  terminalStdout.write(
    `[k8s] Doctor Host -> Kubernetes: profile=${input.profileName}，`
    + `kubeconfig=${input.kubeconfigSource}`
    + `${input.namespace ? `，namespace=${input.namespace}` : ""}\n`,
  );
  const fact = input.commandContext?.inspection.kubernetes?.channel
    ?? await inspectKubernetesChannel(input.executor);
  if (!fact.available) throw new Error(fact.reason ?? "Kubernetes 通道不可用");
  terminalStdout.success("[k8s] Kubernetes API Server 可达\n");
}

export async function enforceKubernetesAccess(
  context: KubernetesAccessContext,
  contract: KubernetesAccessContract,
): Promise<KubernetesAccessEvaluation> {
  const evaluation = await context.evaluate(contract);
  for (const fact of evaluation.facts) {
    const label = accessLabel(fact.need.rule);
    const scope = contract.namespace ? `，namespace=${contract.namespace}` : "";
    if (fact.status === "allowed") {
      terminalStdout.success(
        `[k8s] ${fact.need.requirement}: ${label} ✓（${fact.need.purpose}${scope}）\n`,
      );
      continue;
    }
    const fallback = fact.status === "denied" && fact.need.fallback ? `；${fact.need.fallback}` : "";
    const next = fact.status === "unknown"
      ? `；预检原因：${kubernetesResultDetail(fact.result)}；继续尝试实际操作`
      : fallback;
    terminalStdout.warning(
      `[k8s] ${fact.need.requirement}: ${label} ${fact.status}`
      + `（${fact.need.purpose}${scope}）${next}\n`,
    );
  }
  if (!evaluation.runnable) {
    const missing = evaluation.facts
      .filter((fact) => fact.need.requirement === "required" && fact.status === "denied")
      .map((fact) => `${accessLabel(fact.need.rule)}=${fact.status}`)
      .join("、");
    throw new Error(`[k8s] ${contract.command} 缺少必须的 Kubernetes 权限：${missing}`);
  }
  return evaluation;
}
