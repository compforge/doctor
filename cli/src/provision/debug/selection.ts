import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import type { PodChoice } from "../../infra/k8s/pod-selection";
import type { DebugCliOpts } from "./model";

export function parseDebugServices(raw: string): string[] {
  const services = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!services.length) throw new Error("--services 未解析出任何服务");
  return services;
}

export function resolveSelectedDebugPods(
  choices: readonly PodChoice[],
  selectedNames: readonly string[],
  configuredContainer?: string,
): {
  targets: Map<string, string>;
  errors: string[];
  warnings: string[];
} {
  const targets = new Map<string, string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const name of selectedNames) {
    const pod = choices.find((choice) => choice.name === name);
    if (!pod) {
      errors.push(`Pod '${name}' 不在可选列表中`);
      continue;
    }
    const selected = configuredContainer
      ? pod.containers.find((container) => container.name === configuredContainer)
      : pod.containers[0];
    if (!selected) {
      errors.push(
        configuredContainer
          ? `pod/${pod.name} 中不存在 container '${configuredContainer}'`
          : `pod/${pod.name} 没有业务容器`,
      );
      continue;
    }
    if (!configuredContainer && pod.containers.length > 1) {
      warnings.push(
        `pod/${pod.name} 有多个业务容器；批量准备选择首个 ${selected.name} 作为 PID namespace 目标`
        + "（network namespace 为 Pod 共享）",
      );
    }
    targets.set(pod.name, selected.name);
  }
  return { targets, errors, warnings };
}

export function resolveDebugBatchOptions(
  opts: DebugCliOpts,
  config: KubernetesCommandConfig,
): DebugCliOpts {
  return {
    ...opts,
    namespace: config.kubernetes.namespace,
    kubeconfig: config.kubernetes.kubeconfig,
    context: config.kubernetes.context,
  };
}
