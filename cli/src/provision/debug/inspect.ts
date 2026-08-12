import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  resolvePodTarget,
} from "../../command/kubernetes-target";
import { infra } from "../../infra";
import type { ImagePlatform, RegistryCredentials } from "../../infra/image";
import { inspectPodImagePlatform, pullableImageReference } from "../../infra/k8s/platform";
import { failReason } from "../../infra/k8s/result";
import { parsePodJson, pickContainer } from "../../infra/k8s/target";
import type { DebugEnvironmentFact } from "../../infra/target/debug";
import type { CommandContext } from "../../command";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { terminalStdout } from "../../terminal/output";
import type {
  DebugCliOpts,
  DebugPlatformSource,
  DebugTarget,
} from "./model";

export async function resolveDebugTarget(
  opts: DebugCliOpts,
  commandContext: CommandContext,
): Promise<DebugTarget | undefined> {
  const config = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!config) return undefined;
  const executor = createKubernetesExecutor(config);
  const access = commandContext.kubernetes(executor).access;
  const selected = await resolvePodTarget({
    config,
    executor,
    pod: opts.pod,
    container: opts.container,
    selectContainer: true,
    access,
    commandContext,
    selection: {
      candidateRole: "目标",
      purpose: "准备 debug environment",
    },
  });
  if (!selected) return undefined;
  const podResult = await executor.run(["get", "pod", selected.pod, "-o", "json"], {
    timeoutMs: 20_000,
  });
  if (!podResult.ok) throw new Error(`获取目标 Pod 失败：${failReason(podResult)}`);
  const parsedPod = parsePodJson(podResult.stdout);
  const picked = pickContainer(parsedPod, selected.container);
  if (!picked.ok) throw new Error(picked.reason);
  const nodeAccess = await enforceKubernetesAccess(access, {
    command: "doctor debug",
    needs: [{
      requirement: "preferred",
      rule: { verb: "get", resource: "nodes", resourceName: parsedPod.nodeName },
      purpose: "确认目标 Node 的 amd64/arm64",
      fallback: "按 Pod image manifest 或 multi-arch image 降级",
    }],
  });
  const platform = nodeAccess.facts[0]?.status === "denied"
    ? { reason: "无 nodes/get 权限" }
    : await inspectPodImagePlatform(executor, parsedPod.nodeName);
  return {
    executor,
    context: commandContext,
    namespace: config.kubernetes.namespace,
    pod: selected.pod,
    container: picked.value.name,
    containerImage: picked.value.image,
    containerImageId: picked.value.imageId,
    imagePlatform: platform.platform,
    platformReason: platform.reason,
    podJson: podResult.stdout,
  };
}

export function inspectTargetImagePlatform(
  target: DebugTarget,
  credentials?: RegistryCredentials,
): ImagePlatform | undefined {
  const reference = pullableImageReference(target.containerImageId);
  if (!reference) return undefined;
  return infra.image.inspectPlatform(reference, credentials).platform;
}

export function reportTargetPlatform(
  target: DebugTarget,
  source?: DebugPlatformSource,
): void {
  if (target.imagePlatform) {
    terminalStdout.write(
      `[debug] target platform: ${target.imagePlatform.os}/${target.imagePlatform.architecture}`
      + `${source ? ` (${source})` : ""}\n`,
    );
    return;
  }
  terminalStdout.write(
    `[debug] target platform: unknown（${target.platformReason ?? "Node 和实际 image manifest 均不可读"}）；`
    + "使用 multi-arch image 由 Kubelet 选择\n",
  );
}

export function formatExistingDebugContainers(
  pod: string,
  facts: readonly DebugEnvironmentFact[],
  selectedName?: string,
): string | undefined {
  if (facts.length === 0) return undefined;
  const lines = facts.map((fact) => {
    const selected = fact.executionContainer === selectedName ? "  ← 优先候选" : "";
    return `  - ${fact.executionContainer}  image=${fact.image}  state=${fact.state}${selected}`;
  });
  return `[debug] pod/${pod} 已有 ${facts.length} 个 doctor debug 临时容器`
    + "（Kubernetes 不支持原地删除或替换）：\n"
    + `${lines.join("\n")}\n`;
}
