import { terminalStderr } from "../../terminal/output";
import {
  matchSearchableChoices,
  printNumberedChoices,
  promptSearchableChoice,
  resolveSearchableChoice,
} from "../../terminal/selection";
import type { ResolvedNamespace } from "./context";
import { KubectlExecutor, type Executor } from "./executor";
import type { KubernetesAccessContext } from "./access";
import {
  recentSelectionsForInteractive,
  resolveKubernetesRecentScope,
  type RecentSelections,
} from "../recent";

export interface NamespaceChoice {
  name: string;
  phase: string;
}

interface NamespaceListItem {
  metadata?: { name?: string };
  status?: { phase?: string };
}

export function parseNamespaceChoices(raw: string): NamespaceChoice[] {
  const parsed = JSON.parse(raw) as { items?: NamespaceListItem[] };
  if (!Array.isArray(parsed.items)) throw new Error("Namespace 列表响应缺少 items");
  return parsed.items
    .flatMap((item): NamespaceChoice[] => {
      const name = item.metadata?.name?.trim();
      return name ? [{ name, phase: item.status?.phase ?? "Unknown" }] : [];
    })
    .sort(
      (a, b) => Number(b.phase === "Active") - Number(a.phase === "Active") || a.name.localeCompare(b.name),
    );
}

export function matchNamespaceChoices(
  choices: readonly NamespaceChoice[],
  keyword: string,
): NamespaceChoice[] {
  return matchSearchableChoices(choices, keyword, (choice) => choice.name);
}

function printNamespaceChoices(choices: readonly NamespaceChoice[], title: string): void {
  printNumberedChoices(choices, title, (choice) => `${choice.name}  ${choice.phase}`);
}

export type NamespaceAnswerResolution =
  | { kind: "selected"; namespace: string }
  | { kind: "ambiguous"; matches: NamespaceChoice[] }
  | { kind: "not-found" }
  | { kind: "invalid-number" };

export function resolveNamespaceAnswer(
  choices: readonly NamespaceChoice[],
  answer: string,
  defaultNamespace: string,
  numberedChoices: readonly NamespaceChoice[] = [],
): NamespaceAnswerResolution {
  const normalized = answer.trim();
  if (!normalized) return { kind: "selected", namespace: defaultNamespace };
  if (choices.length === 0 && /^\d+$/.test(normalized)) return { kind: "invalid-number" };
  if (choices.length === 0) return { kind: "selected", namespace: normalized };
  const resolution = resolveSearchableChoice(
    choices,
    normalized,
    numberedChoices,
    (choice) => choice.name,
    (choice) => choice.name,
  );
  return resolution.kind === "selected"
    ? { kind: "selected", namespace: resolution.value }
    : resolution;
}

export async function promptNamespace(
  choices: readonly NamespaceChoice[],
  defaultNamespace: string,
): Promise<string | undefined> {
  if (choices.length > 0) {
    printNamespaceChoices(choices, "[collect] 待操作 Service 所在的 Namespace：");
  }
  return promptSearchableChoice({
    choices,
    choicesAreListed: choices.length > 0,
    question: () => `请选择待操作 Service 所在的 Namespace（序号、名称或关键词，回车使用 ${defaultNamespace}，q 取消）：`,
    resolve: (answer, numberedChoices) => {
      const resolution = resolveNamespaceAnswer(choices, answer, defaultNamespace, numberedChoices);
      return resolution.kind === "selected"
        ? { kind: "selected", value: resolution.namespace }
        : resolution;
    },
    printChoices: printNamespaceChoices,
    ambiguousTitle: (answer) => `[collect] 关键词 '${answer}' 匹配到多个 Namespace：`,
    notFoundMessage: (answer) => `[collect] 未找到匹配 '${answer}' 的 Namespace，请重新输入。`,
    invalidNumberMessage: "输入的序号不在当前候选中，请输入 Namespace 名称或关键词。",
  });
}

export interface PodNamespaceSelection {
  resolved: ResolvedNamespace;
  kubeconfig?: string;
  context?: string;
  executor?: Executor;
  interactive?: boolean;
  prompt?: typeof promptNamespace;
  access?: KubernetesAccessContext;
  recent?: RecentSelections;
}

/** Pod 选择之前确定其 namespace 作用域；显式 flag/profile 不再重复询问。 */
export async function resolvePodNamespace(
  input: PodNamespaceSelection,
): Promise<ResolvedNamespace | undefined> {
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (input.resolved.source !== "default" || !interactive) return input.resolved;
  const recent = recentSelectionsForInteractive(input.interactive, input.recent);
  const recentScope = resolveKubernetesRecentScope(input);

  const executor = input.executor ?? new KubectlExecutor({
    kubeconfig: input.kubeconfig,
    context: input.context,
  });
  const evaluated = input.access
    ? await input.access.evaluate({
        command: "Namespace selection",
        needs: [{
          requirement: "preferred",
          rule: { verb: "list", resource: "namespaces" },
          purpose: "提供可搜索的 Namespace 候选",
          fallback: "改为手动输入 Namespace",
        }],
      })
    : undefined;
  const permission = evaluated?.facts[0];
  if (permission?.status === "denied") {
    terminalStderr.warning(
      `[k8s] preferred: list namespaces ${permission.status}`
      + "（Namespace 候选发现）；改为手动输入\n",
    );
    const selected = await (input.prompt ?? promptNamespace)([], input.resolved.namespace);
    return selected ? { namespace: selected, source: "prompt" } : undefined;
  }
  const listed = await executor.run(["get", "namespaces", "-o", "json"], { timeoutMs: 20_000 });
  let choices: NamespaceChoice[] = [];
  if (listed.ok) {
    try {
      const parsed = parseNamespaceChoices(listed.stdout);
      choices = recent ? recent.rankNamespaces(recentScope, parsed) : parsed;
    } catch (error) {
      terminalStderr.error(
        `[collect] 解析 Namespace 列表失败，改为手动输入：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  } else {
    terminalStderr.error(
      `[collect] 获取 Namespace 列表失败，改为手动输入：${listed.stderr.trim() || `exit=${listed.exitCode}`}\n`,
    );
  }

  const selected = await (input.prompt ?? promptNamespace)(choices, input.resolved.namespace);
  return selected ? { namespace: selected, source: "prompt" } : undefined;
}
