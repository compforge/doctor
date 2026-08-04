import {
  RecentStore,
  type ImageRecentTarget,
  type KubernetesRecentTarget,
} from "./recent-store";
import type { KubernetesRecentScope } from "./k8s/recent-scope";
export {
  resolveKubernetesRecentScope,
  type KubernetesRecentScope,
} from "./k8s/recent-scope";

const MAX_KUBERNETES_TARGETS = 200;
const MAX_IMAGE_TARGETS = 50;

interface NamedChoice {
  name: string;
}

function sameScope(
  target: Pick<KubernetesRecentTarget, "kubeconfig" | "context">,
  scope: KubernetesRecentScope,
): boolean {
  return target.kubeconfig === scope.kubeconfig && target.context === scope.context;
}

function compareUsage(
  left: { last_used_at: string; use_count: number } | undefined,
  right: { last_used_at: string; use_count: number } | undefined,
): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.last_used_at.localeCompare(left.last_used_at)
    || right.use_count - left.use_count;
}

function usageByName(
  targets: readonly KubernetesRecentTarget[],
  field: "namespace" | "service" | "pod" | "container",
): Map<string, { last_used_at: string; use_count: number }> {
  const usage = new Map<string, { last_used_at: string; use_count: number }>();
  for (const target of targets) {
    const name = target[field];
    if (!name) continue;
    const current = usage.get(name);
    usage.set(name, {
      last_used_at: !current || target.last_used_at > current.last_used_at
        ? target.last_used_at
        : current.last_used_at,
      use_count: (current?.use_count ?? 0) + target.use_count,
    });
  }
  return usage;
}

function rankNamedChoices<Choice extends NamedChoice>(
  choices: readonly Choice[],
  usage: ReadonlyMap<string, { last_used_at: string; use_count: number }>,
  priority: (choice: Choice) => number = () => 0,
): Choice[] {
  return [...choices].sort((left, right) =>
    priority(right) - priority(left)
    || compareUsage(usage.get(left.name), usage.get(right.name))
    || left.name.localeCompare(right.name)
  );
}

function kubernetesTargetKey(
  target: Omit<KubernetesRecentTarget, "last_used_at" | "use_count">,
): string {
  return [
    target.kubeconfig,
    target.context,
    target.namespace,
    target.service ?? "",
    target.pod ?? "",
    target.container ?? "",
  ].join("\u0000");
}

function imageTargetKey(
  target: Omit<ImageRecentTarget, "last_used_at" | "use_count">,
): string {
  return [
    target.kubeconfig,
    target.context,
    target.registry,
    target.namespace,
  ].join("\u0000");
}

export class RecentSelections {
  readonly #store: RecentStore;

  constructor(
    path?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#store = new RecentStore(path);
  }

  get path(): string {
    return this.#store.path;
  }

  rankNamespaces<Choice extends NamedChoice & { phase: string }>(
    scope: KubernetesRecentScope,
    choices: readonly Choice[],
  ): Choice[] {
    const targets = this.#store.read().kubernetes.targets.filter((target) => sameScope(target, scope));
    return rankNamedChoices(
      choices,
      usageByName(targets, "namespace"),
      (choice) => Number(choice.phase === "Active"),
    );
  }

  rankPods<Choice extends NamedChoice & { phase: string }>(
    scope: KubernetesRecentScope,
    namespace: string,
    choices: readonly Choice[],
    service?: string,
  ): Choice[] {
    const targets = this.#store.read().kubernetes.targets.filter((target) =>
      sameScope(target, scope)
      && target.namespace === namespace
      && (!service || target.service === service)
    );
    return rankNamedChoices(
      choices,
      usageByName(targets, "pod"),
      (choice) => Number(choice.phase === "Running"),
    );
  }

  recentPods<Choice extends NamedChoice & { phase: string }>(
    scope: KubernetesRecentScope,
    namespace: string,
    choices: readonly Choice[],
    limit = 5,
  ): Choice[] {
    const targets = this.#store.read().kubernetes.targets.filter((target) =>
      sameScope(target, scope) && target.namespace === namespace
    );
    const usage = usageByName(targets, "pod");
    return rankNamedChoices(choices, usage)
      .filter((choice) => usage.has(choice.name))
      .slice(0, limit);
  }

  rankContainers<Choice extends NamedChoice>(
    scope: KubernetesRecentScope,
    namespace: string,
    pod: string,
    choices: readonly Choice[],
  ): Choice[] {
    const targets = this.#store.read().kubernetes.targets.filter((target) =>
      sameScope(target, scope) && target.namespace === namespace && target.pod === pod
    );
    return rankNamedChoices(choices, usageByName(targets, "container"));
  }

  rankServices<Choice extends NamedChoice>(
    scope: KubernetesRecentScope,
    namespace: string,
    choices: readonly Choice[],
  ): Choice[] {
    const targets = this.#store.read().kubernetes.targets.filter((target) =>
      sameScope(target, scope) && target.namespace === namespace
    );
    return rankNamedChoices(choices, usageByName(targets, "service"));
  }

  recordKubernetesTarget(
    scope: KubernetesRecentScope,
    target: {
      namespace: string;
      service?: string;
      pod?: string;
      container?: string;
    },
  ): void {
    this.#store.update((document) => {
      const next = {
        ...scope,
        ...target,
      };
      const key = kubernetesTargetKey(next);
      const previous = document.kubernetes.targets.find(
        (item) => kubernetesTargetKey(item) === key,
      );
      document.kubernetes.targets = [
        {
          ...next,
          last_used_at: this.now().toISOString(),
          use_count: (previous?.use_count ?? 0) + 1,
        },
        ...document.kubernetes.targets.filter(
          (item) => kubernetesTargetKey(item) !== key,
        ),
      ]
        .sort((left, right) => right.last_used_at.localeCompare(left.last_used_at))
        .slice(0, MAX_KUBERNETES_TARGETS);
    });
  }

  rankImageRegistries(
    scope: KubernetesRecentScope,
    registries: readonly string[],
  ): string[] {
    const usage = new Map<string, { last_used_at: string; use_count: number }>();
    for (const target of this.#store.read().images.targets) {
      if (!sameScope(target, scope)) continue;
      const current = usage.get(target.registry);
      usage.set(target.registry, {
        last_used_at: !current || target.last_used_at > current.last_used_at
          ? target.last_used_at
          : current.last_used_at,
        use_count: (current?.use_count ?? 0) + target.use_count,
      });
    }
    return rankNamedChoices(
      registries.map((name) => ({ name })),
      usage,
    ).map((choice) => choice.name);
  }

  rankImageNamespaces(
    scope: KubernetesRecentScope,
    registry: string,
    namespaces: readonly string[],
  ): string[] {
    const usage = new Map(
      this.#store.read().images.targets
        .filter((target) => sameScope(target, scope) && target.registry === registry)
        .map((target) => [
          target.namespace,
          { last_used_at: target.last_used_at, use_count: target.use_count },
        ]),
    );
    return rankNamedChoices(
      namespaces.map((name) => ({ name })),
      usage,
    ).map((choice) => choice.name);
  }

  recordImageTarget(
    scope: KubernetesRecentScope,
    target: { registry: string; namespace: string },
  ): void {
    this.#store.update((document) => {
      const next = { ...scope, ...target };
      const key = imageTargetKey(next);
      const previous = document.images.targets.find(
        (item) => imageTargetKey(item) === key,
      );
      document.images.targets = [
        {
          ...next,
          last_used_at: this.now().toISOString(),
          use_count: (previous?.use_count ?? 0) + 1,
        },
        ...document.images.targets.filter((item) => imageTargetKey(item) !== key),
      ]
        .sort((left, right) => right.last_used_at.localeCompare(left.last_used_at))
        .slice(0, MAX_IMAGE_TARGETS);
    });
  }

}

/** Tests may inject a store; automatic persistence only activates for a real TTY. */
export function recentSelectionsForInteractive(
  interactive: boolean | undefined,
  injected?: RecentSelections,
): RecentSelections | undefined {
  if (injected) return injected;
  const terminalIsInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);
  return (interactive ?? terminalIsInteractive) && terminalIsInteractive
    ? new RecentSelections()
    : undefined;
}
