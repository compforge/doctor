import type { Executor } from "./executor";

export function parseKubernetesServerVersion(raw: string): string | undefined {
  try {
    const value = (JSON.parse(raw) as { gitVersion?: unknown }).gitVersion;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort API Server version lookup for lightweight environment reporting. */
export async function getKubernetesServerVersion(
  executor: Executor,
  timeoutMs = 500,
): Promise<string | undefined> {
  const result = await executor.run(
    ["--request-timeout=300ms", "get", "--raw=/version"],
    { timeoutMs },
  );
  return result.ok ? parseKubernetesServerVersion(result.stdout) : undefined;
}
