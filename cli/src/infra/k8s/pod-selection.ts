import {
  matchSearchableChoices,
  printNumberedChoices,
  promptSearchableChoice,
  resolveSearchableChoice,
} from "../../terminal/selection";
import type { ContainerChoice } from "./container-selection";

export interface PodChoice {
  name: string;
  phase: string;
  ready: string;
  restarts: number;
  containers: ContainerChoice[];
}

interface PodListItem {
  metadata?: { name?: string; deletionTimestamp?: string };
  spec?: {
    containers?: Array<{ name?: string; image?: string }>;
    ephemeralContainers?: Array<{ name?: string; image?: string }>;
  };
  status?: {
    phase?: string;
    containerStatuses?: Array<{ ready?: boolean; restartCount?: number }>;
    ephemeralContainerStatuses?: Array<{
      name?: string;
      state?: { running?: unknown };
    }>;
  };
}

/** 从 kubectl JSON 提取面向交互选择的精简 Pod 状态。 */
export function parsePodChoices(
  raw: string,
  options?: { includeEphemeralContainers?: boolean },
): PodChoice[] {
  const parsed = JSON.parse(raw) as { items?: PodListItem[] };
  if (!Array.isArray(parsed.items)) throw new Error("Pod 列表响应缺少 items");
  return parsed.items
    .flatMap((item): PodChoice[] => {
      const name = item.metadata?.name?.trim();
      if (!name) return [];
      const statuses = item.status?.containerStatuses ?? [];
      const total = item.spec?.containers?.length ?? statuses.length;
      const runningEphemeral = new Set(
        (item.status?.ephemeralContainerStatuses ?? [])
          .filter((status) => status.state?.running)
          .flatMap((status) => status.name?.trim() ? [status.name.trim()] : []),
      );
      const containers = [
        ...(item.spec?.containers ?? []),
        ...(options?.includeEphemeralContainers
          ? (item.spec?.ephemeralContainers ?? []).filter(
              (container) => runningEphemeral.has(container.name?.trim() ?? ""),
            )
          : []),
      ];
      return [{
        name,
        phase: item.metadata?.deletionTimestamp ? "Terminating" : (item.status?.phase ?? "Unknown"),
        ready: `${statuses.filter((status) => status.ready).length}/${total}`,
        restarts: statuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
        containers: containers.flatMap((container) => {
          const containerName = container.name?.trim();
          return containerName ? [{ name: containerName, image: container.image ?? "" }] : [];
        }),
      }];
    })
    .sort(
      (a, b) =>
        Number(b.phase === "Running") - Number(a.phase === "Running") || a.name.localeCompare(b.name),
    );
}

/** 完整名称优先；否则按名称包含关系做不区分大小写的关键词匹配。 */
export function matchPodChoices(
  choices: readonly PodChoice[],
  keyword: string,
): PodChoice[] {
  return matchSearchableChoices(choices, keyword, (choice) => choice.name);
}

export function printPodChoices(choices: readonly PodChoice[], title: string): void {
  printNumberedChoices(
    choices,
    title,
    (choice) => `${choice.name}  ${choice.phase}  ready=${choice.ready}  restarts=${choice.restarts}`,
  );
}

const POD_PREVIEW_LIMIT = 10;

/** 小规模候选直接展示，用户可以立即按序号选择；大列表仍先按关键词收窄。 */
export function shouldPreviewPodChoices(
  choices: readonly PodChoice[],
  numberedChoices: readonly PodChoice[],
): boolean {
  return numberedChoices.length === 0
    && choices.length > 0
    && choices.length <= POD_PREVIEW_LIMIT;
}

export type PodAnswerResolution =
  | { kind: "selected"; pod: string }
  | { kind: "ambiguous"; matches: PodChoice[] }
  | { kind: "not-found" }
  | { kind: "invalid-number" };

/** 序号只对已经展示过的候选生效；名称或关键词始终在本轮可选 Pod 中匹配。 */
export function resolvePodAnswer(
  choices: readonly PodChoice[],
  answer: string,
  numberedChoices: readonly PodChoice[] = [],
): PodAnswerResolution {
  const resolution = resolveSearchableChoice(
    choices,
    answer,
    numberedChoices,
    (choice) => choice.name,
    (choice) => choice.name,
  );
  return resolution.kind === "selected"
    ? { kind: "selected", pod: resolution.value }
    : resolution;
}

export async function promptPod(
  choices: readonly PodChoice[],
  listedChoices: boolean | readonly PodChoice[] = false,
): Promise<string | undefined> {
  let numberedChoices = Array.isArray(listedChoices)
    ? listedChoices
    : listedChoices
      ? choices
      : [];
  if (shouldPreviewPodChoices(choices, numberedChoices)) {
    printPodChoices(choices, "[collect] 可选择的 Pod：");
    numberedChoices = choices;
  }
  return promptSearchableChoice({
    choices,
    numberedChoices,
    question: (listed) => listed
      ? "请选择 Pod（序号、名称或关键词，q 取消）："
      : "请输入 Pod 名称或关键词（q 取消）：",
    resolve: (answer, numberedChoices) => {
      const resolution = resolvePodAnswer(choices, answer, numberedChoices);
      return resolution.kind === "selected"
        ? { kind: "selected", value: resolution.pod }
        : resolution;
    },
    printChoices: printPodChoices,
    ambiguousTitle: (answer) => `[collect] 关键词 '${answer}' 匹配到多个 Pod：`,
    notFoundMessage: (answer) => `[collect] 未找到匹配 '${answer}' 的 Pod，请重新输入。`,
    invalidNumberMessage: "输入的序号不在当前候选中，请输入 Pod 名称或关键词。",
    emptyMessage: "请输入 Pod 名称或关键词。",
  });
}
