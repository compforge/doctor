import type { Executor } from "./executor";
import { parseServices } from "./service";
import {
  recentSelectionsForInteractive,
  resolveKubernetesRecentScope,
  type RecentSelections,
} from "../recent";

export interface ServiceChoice {
  name: string;
}

export interface RecentServiceSelection {
  namespace: string;
  kubeconfig?: string;
  context?: string;
  interactive?: boolean;
  recent?: RecentSelections;
}

export function parseServiceChoices(raw: string, namespace: string): ServiceChoice[] {
  return parseServices(raw, namespace)
    .map((service) => ({ name: service.name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listServiceChoices(
  executor: Executor,
  namespace: string,
): Promise<ServiceChoice[]> {
  const result = await executor.run(["get", "services", "-o", "json"], { timeoutMs: 20_000 });
  if (!result.ok) {
    throw new Error(`读取 Service 失败：${result.stderr.trim() || `exit=${result.exitCode}`}`);
  }
  return parseServiceChoices(result.stdout, namespace);
}

export function rankRecentServiceChoices(
  choices: readonly ServiceChoice[],
  input: RecentServiceSelection,
): ServiceChoice[] {
  const recent = recentSelectionsForInteractive(input.interactive, input.recent);
  return recent
    ? recent.rankServices(resolveKubernetesRecentScope(input), input.namespace, choices)
    : [...choices];
}

export function recordRecentServiceTargets(
  services: readonly string[],
  input: RecentServiceSelection,
): void {
  const recent = recentSelectionsForInteractive(input.interactive, input.recent);
  if (!recent) return;
  const scope = resolveKubernetesRecentScope(input);
  for (const service of services) {
    recent.recordKubernetesTarget(scope, { namespace: input.namespace, service });
  }
}
