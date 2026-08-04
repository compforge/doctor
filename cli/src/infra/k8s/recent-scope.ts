import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface KubernetesRecentScope {
  kubeconfig: string;
  context: string;
}

function readCurrentContext(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    try {
      const parsed = parseYaml(readFileSync(path, "utf8")) as { "current-context"?: unknown } | null;
      const context = parsed?.["current-context"];
      if (typeof context === "string" && context.trim()) return context.trim();
    } catch {
      // Recent state is an optional UX aid; an unreadable kubeconfig must not block the command.
    }
  }
  return undefined;
}

/** Resolve the stable identity used to keep recent targets from leaking across clusters. */
export function resolveKubernetesRecentScope(input: {
  kubeconfig?: string;
  context?: string;
}): KubernetesRecentScope {
  const configured = input.kubeconfig?.trim()
    || process.env.KUBECONFIG?.trim()
    || join(homedir(), ".kube", "config");
  const paths = configured.split(delimiter).filter(Boolean);
  return {
    kubeconfig: configured,
    context: input.context?.trim() || readCurrentContext(paths) || "current",
  };
}
