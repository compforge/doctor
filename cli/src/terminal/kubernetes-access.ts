import {
  accessLabel,
  inspectKubernetesChannel,
  kubernetesResultDetail,
  type KubernetesAccessContract,
  type KubernetesAccessEvaluation,
  type KubernetesAccessContext,
} from "../infra/k8s/access";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../command";

import { useLogger } from "./log";

export async function requireKubernetesChannel(input: {
  executor: Executor;
  profileName: string;
  kubeconfigSource: string;
  namespace?: string;
  commandContext?: CommandContext;
}): Promise<void> {
  useLogger("k8s").info(`Doctor Host -> Kubernetes: profile=${input.profileName}，`
    + `kubeconfig=${input.kubeconfigSource}`
    + `${input.namespace ? `，namespace=${input.namespace}` : ""}`);
  const fact = input.commandContext?.inspection.kubernetes?.channel
    ?? await inspectKubernetesChannel(input.executor);
  if (!fact.available) throw new Error(fact.reason ?? "Kubernetes 通道不可用");
  useLogger("k8s").success("Kubernetes API Server 可达");
}

const reportedAccess = new WeakMap<KubernetesAccessContext, Set<string>>();

export async function enforceKubernetesAccess(
  context: KubernetesAccessContext,
  contract: KubernetesAccessContract,
): Promise<KubernetesAccessEvaluation> {
  const evaluation = await context.evaluate(contract);
  for (const fact of evaluation.facts) {
    const label = accessLabel(fact.need.rule);
    const scope = contract.namespace ? `，namespace=${contract.namespace}` : "";
    if (fact.status === "allowed") {
      const reported = reportedAccess.get(context) ?? new Set<string>();
      reportedAccess.set(context, reported);
      const key = JSON.stringify([contract.namespace, fact.need.rule, fact.need.requirement]);
      if (reported.has(key)) continue;
      reported.add(key);
      useLogger("k8s").success(`${fact.need.requirement}: ${label} ✓（${fact.need.purpose}${scope}）`);
      continue;
    }
    const fallback = fact.status === "denied" && fact.need.fallback ? `；${fact.need.fallback}` : "";
    const next = fact.status === "unknown"
      ? `；预检原因：${kubernetesResultDetail(fact.result)}；继续尝试实际操作`
      : fallback;
    useLogger("k8s").warn(`${fact.need.requirement}: ${label} ${fact.status}`
      + `（${fact.need.purpose}${scope}）${next}`);
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
