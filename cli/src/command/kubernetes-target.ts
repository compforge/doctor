import { terminalStdout } from "../terminal/output";
import {
  resolveCollectKubeconfig,
  resolveCollectNamespace,
  type ResolvedNamespace,
} from "../infra/k8s/context";
import { resolveWorkingProfileName } from "../app/profile";
import { KubectlExecutor, type Executor } from "../infra/k8s/executor";
import type { KubernetesAccessContext } from "../infra/k8s/access";
import { resolvePodNamespace } from "../infra/k8s/namespace-selection";
import {
  matchPodChoices,
  parsePodChoices,
  printPodChoices,
  promptPod,
} from "../infra/k8s/pod-selection";
import {
  printContainerChoices,
  promptContainer,
} from "../infra/k8s/container-selection";
import { failReason } from "../infra/k8s/result";
import {
  enforceKubernetesAccess,
  requireKubernetesChannel,
} from "../terminal/kubernetes-access";
import {
  resolveKubernetesCommandContext,
  type CommandContext,
} from "./context";
import {
  recentSelectionsForInteractive,
  resolveKubernetesRecentScope,
  type RecentSelections,
} from "../infra/recent";
import {
  resolveUserSelection,
  selectionCandidateLabel,
  type SelectionContext,
} from "../terminal/selection-context";

export interface KubernetesCommandInput {
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
}

/** YAML/profile、CLI flag 与交互输入合并后的命令级 Kubernetes 配置。 */
export interface KubernetesCommandConfig {
  profileName: string;
  kubernetes: {
    kubeconfig?: string;
    kubeconfigSource: string;
    context?: string;
    namespace: string;
    namespaceSource: ResolvedNamespace["source"];
  };
}

export interface PodTarget {
  pod: string;
  container?: string;
}

export async function resolveKubernetesCommandConfig(
  input: KubernetesCommandInput,
  executor?: Executor,
  commandContext?: CommandContext,
): Promise<KubernetesCommandConfig | undefined> {
  const kube = resolveCollectKubeconfig(input, commandContext?.profile);
  const profileName = commandContext?.profile.name ?? resolveWorkingProfileName(input);
  const configuredNamespace = resolveCollectNamespace(input, commandContext?.profile);
  const channelExecutor = executor ?? new KubectlExecutor({
    kubeconfig: kube.kubeconfig,
    context: input.context,
  });
  const kubernetes = resolveKubernetesCommandContext(
    channelExecutor,
    commandContext,
  );
  if (!executor) {
    await requireKubernetesChannel({
      executor: channelExecutor,
      profileName,
      kubeconfigSource: kube.source,
      commandContext,
    });
  }
  const namespace = await resolvePodNamespace({
    resolved: configuredNamespace,
    kubeconfig: kube.kubeconfig,
    context: input.context,
    executor: channelExecutor,
    access: kubernetes.access,
  });
  if (!namespace) return undefined;
  return {
    profileName,
    kubernetes: {
      kubeconfig: kube.kubeconfig,
      kubeconfigSource: kube.source,
      context: input.context,
      namespace: namespace.namespace,
      namespaceSource: namespace.source,
    },
  };
}

export function createKubernetesExecutor(
  config: KubernetesCommandConfig,
): Executor {
  return new KubectlExecutor({
    namespace: config.kubernetes.namespace,
    kubeconfig: config.kubernetes.kubeconfig,
    context: config.kubernetes.context,
  });
}

export async function resolvePodTarget(input: {
  config: KubernetesCommandConfig;
  executor: Executor;
  pod?: string;
  container?: string;
  selectContainer?: boolean;
  includeEphemeralContainers?: boolean;
  interactive?: boolean;
  access?: KubernetesAccessContext;
  recent?: RecentSelections;
  commandContext?: CommandContext;
  selection: SelectionContext;
}): Promise<PodTarget | undefined> {
  const recent = recentSelectionsForInteractive(input.interactive, input.recent);
  const recentScope = resolveKubernetesRecentScope(input.config.kubernetes);
  const record = (
    target: PodTarget,
    selectedInteractively: boolean,
  ): PodTarget => {
    if (selectedInteractively) {
      recent?.recordKubernetesTarget(recentScope, {
        namespace: input.config.kubernetes.namespace,
        pod: target.pod,
        container: target.container,
      });
    }
    return target;
  };
  const discovery = input.access
    ? await enforceKubernetesAccess(input.access, {
        command: "Pod target selection",
        needs: [{
          requirement: "preferred",
          rule: { verb: "list", resource: "pods" },
          purpose: "提供可搜索的 Pod 候选",
          fallback: "改为手动输入精确 Pod 名称",
        }],
      })
    : undefined;
  if (discovery?.facts[0]?.status === "denied") {
    return resolveExplicitPodTarget(input, recent, recentScope);
  }

  const podList = await input.executor.run(["get", "pods", "-o", "json"], { timeoutMs: 20_000 });
  if (!podList.ok) {
    if (/\bforbidden\b/i.test(podList.stderr)) return resolveExplicitPodTarget(input);
    throw new Error(`获取 Pod 列表失败：${failReason(podList)}`);
  }
  let choices;
  try {
    const parsed = parsePodChoices(podList.stdout, {
      includeEphemeralContainers: input.includeEphemeralContainers,
    });
    choices = recent
      ? recent.rankPods(recentScope, input.config.kubernetes.namespace, parsed)
      : parsed;
  } catch (error) {
    throw new Error(
      `解析 Pod 列表失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const namespace = input.config.kubernetes.namespace;
  const keyword = input.pod?.trim();
  const matches = keyword ? matchPodChoices(choices, keyword) : choices;
  if (matches.length === 0) {
    throw new Error(
      keyword
        ? `namespace '${namespace}' 中无法找到匹配 '${keyword}' 的 Pod`
        : `namespace '${namespace}' 中没有可选 Pod`,
    );
  }
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  let selected = keyword && matches.length === 1 ? matches[0] : undefined;
  let selectedInteractively = false;
  if (selected) {
    const pod = selected.name;
    if (pod !== keyword) {
      terminalStdout.write(
        `[collect] ${selectionCandidateLabel(input.selection, "Pod")}: ${pod}`
        + `（关键词 '${keyword}' 唯一匹配）\n`,
      );
    }
  } else {
    if (!interactive) {
      throw new Error(
        keyword
          ? "当前为非交互终端；请使用更精确的 --pod <pod>"
          : "当前为非交互终端；请显式指定 --pod <pod>",
      );
    }
    if (keyword) {
      printPodChoices(
        matches,
        `[collect] 关键词 '${keyword}' 匹配到多个`
        + `${selectionCandidateLabel(input.selection, "Pod")}：`,
      );
    }
    const recentPods = !keyword && recent
      ? recent.recentPods(recentScope, input.config.kubernetes.namespace, matches)
      : [];
    if (recentPods.length) {
      printPodChoices(recentPods, "[recent] 最近常用 Pod：");
    }
    const selectPod = () => promptPod(matches, {
      selection: input.selection,
      listedChoices: keyword ? true : recentPods,
    });
    const pod = input.commandContext
      ? await resolveUserSelection(
          input.commandContext,
          input.selection,
          "Pod",
          [namespace],
          selectPod,
        )
      : await selectPod();
    if (!pod) return undefined;
    selected = choices.find((choice) => choice.name === pod);
    if (!selected) {
      throw new Error(
        `${selectionCandidateLabel(input.selection, "Pod")} pod/${pod} 已不在当前候选中`,
      );
    }
    selectedInteractively = true;
  }

  const pod = selected!.name;
  if (!input.selectContainer) {
    return record({ pod, container: input.container }, selectedInteractively);
  }

  const containers = recent
    ? recent.rankContainers(
        recentScope,
        input.config.kubernetes.namespace,
        pod,
        selected!.containers,
      )
    : selected!.containers;
  const configuredContainer = input.container?.trim();
  if (configuredContainer) {
    if (!containers.some((container) => container.name === configuredContainer)) {
      throw new Error(
        `pod/${pod} 中不存在 container '${configuredContainer}'；候选: ${containers.map((container) => container.name).join(", ")}`,
      );
    }
    return record({ pod, container: configuredContainer }, selectedInteractively);
  }
  if (containers.length === 0) throw new Error(`pod/${pod} 没有可选 Container`);
  if (containers.length === 1) {
    const container = containers[0]!.name;
    const label = input.selection.candidateRole === "配置来源"
      ? "[collect] 配置来源 Container"
      : "[target] container";
    terminalStdout.write(
      `${label}: ${container}`
      + `（pod/${pod} 仅有一个 Container，自动选择）\n`,
    );
    return record({ pod, container }, selectedInteractively);
  }
  if (!interactive) {
    throw new Error(
      `pod/${pod} 有 ${containers.length} 个容器；当前为非交互终端，请显式指定 --container <name>`,
    );
  }
  printContainerChoices(containers, pod, input.selection);
  const selectContainer = () => promptContainer(containers, input.selection);
  const container = input.commandContext
    ? await resolveUserSelection(
        input.commandContext,
        input.selection,
        "Container",
        [namespace, pod],
        selectContainer,
      )
    : await selectContainer();
  return container ? record({ pod, container }, true) : undefined;
}

async function resolveExplicitPodTarget(input: {
  config: KubernetesCommandConfig;
  executor: Executor;
  pod?: string;
  container?: string;
  selectContainer?: boolean;
  includeEphemeralContainers?: boolean;
  interactive?: boolean;
  access?: KubernetesAccessContext;
  recent?: RecentSelections;
  commandContext?: CommandContext;
  selection: SelectionContext;
},
recent = recentSelectionsForInteractive(input.interactive, input.recent),
recentScope = resolveKubernetesRecentScope(input.config.kubernetes),
): Promise<PodTarget | undefined> {
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  let pod = input.pod?.trim();
  let selectedInteractively = false;
  if (!pod) {
    if (!interactive) {
      throw new Error("无 list pods 权限；非交互环境请显式指定精确的 --pod <pod>");
    }
    const selectPod = () => promptPod([], { selection: input.selection });
    pod = input.commandContext
      ? await resolveUserSelection(
          input.commandContext,
          input.selection,
          "Pod",
          [input.config.kubernetes.namespace],
          selectPod,
        )
      : await selectPod();
    if (!pod) return undefined;
    selectedInteractively = true;
  }
  const record = (
    target: PodTarget,
    usedPrompt = selectedInteractively,
  ): PodTarget => {
    if (usedPrompt) {
      recent?.recordKubernetesTarget(recentScope, {
        namespace: input.config.kubernetes.namespace,
        pod: target.pod,
        container: target.container,
      });
    }
    return target;
  };

  if (input.access) {
    await enforceKubernetesAccess(input.access, {
      command: "Pod target selection",
      needs: [{
        requirement: "required",
        rule: { verb: "get", resource: "pods", resourceName: pod },
        purpose: "读取手动指定 Pod 的 Container 与状态",
      }],
    });
  }
  const captured = await input.executor.run(["get", "pod", pod, "-o", "json"], { timeoutMs: 20_000 });
  if (!captured.ok) throw new Error(`获取 pod/${pod} 失败：${failReason(captured)}`);
  let choices;
  try {
    const parsed = JSON.parse(captured.stdout) as Record<string, unknown>;
    choices = parsePodChoices(JSON.stringify({ items: [parsed] }), {
      includeEphemeralContainers: input.includeEphemeralContainers,
    });
  } catch (error) {
    throw new Error(
      `解析 pod/${pod} 失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const selected = choices[0];
  if (!selected) throw new Error(`pod/${pod} 缺少可选择的信息`);
  if (!input.selectContainer) return record({ pod, container: input.container });

  const configuredContainer = input.container?.trim();
  const containers = recent
    ? recent.rankContainers(
        recentScope,
        input.config.kubernetes.namespace,
        pod,
        selected.containers,
      )
    : selected.containers;
  if (configuredContainer) {
    if (!containers.some((container) => container.name === configuredContainer)) {
      throw new Error(
        `pod/${pod} 中不存在 container '${configuredContainer}'；候选: `
        + containers.map((container) => container.name).join(", "),
      );
    }
    return record({ pod, container: configuredContainer });
  }
  if (containers.length === 0) throw new Error(`pod/${pod} 没有可选 Container`);
  if (containers.length === 1) {
    const container = containers[0]!.name;
    const label = input.selection.candidateRole === "配置来源"
      ? "[collect] 配置来源 Container"
      : "[target] container";
    terminalStdout.write(
      `${label}: ${container}`
      + `（pod/${pod} 仅有一个 Container，自动选择）\n`,
    );
    return record({ pod, container });
  }
  if (!interactive) {
    throw new Error(
      `pod/${pod} 有 ${containers.length} 个容器；当前为非交互终端，请显式指定 --container <name>`,
    );
  }
  printContainerChoices(containers, pod, input.selection);
  const selectContainer = () => promptContainer(containers, input.selection);
  const container = input.commandContext
    ? await resolveUserSelection(
        input.commandContext,
        input.selection,
        "Container",
        [input.config.kubernetes.namespace, pod],
        selectContainer,
      )
    : await selectContainer();
  return container ? record({ pod, container }, true) : undefined;
}
