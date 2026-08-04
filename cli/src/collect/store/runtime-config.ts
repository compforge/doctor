import {
  loadDeclaredContainerConfig,
  type DeclaredContainerConfig,
} from "../../infra/k8s/container-config";
import type { ExecResult, ExecTarget, Executor } from "../../infra/k8s/executor";

export interface ServiceRuntimeConfig {
  environment: Map<string, string>;
  source: "kubernetes-config" | "container-runtime";
  captures: ExecResult[];
  reason?: string;
}

export function parseEnvironment(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

export function configuredValue(environment: Map<string, string>, name: string): string | undefined {
  const value = environment.get(name)?.trim();
  return value || undefined;
}

function failedExecReason(capture: ExecResult): string {
  return capture.stderr.trim().split("\n")[0] || `exit=${capture.exitCode}`;
}

/**
 * Catalog 声明 Service 可能提供某类 Store 配置；是否启用由本次运行时配置决定。
 * 声明值不足时才读取 Container env，空值保持为 unavailable，不能误当成坏凭据。
 */
export async function loadServiceRuntimeConfig(
  executor: Executor,
  target: ExecTarget,
  isComplete: (environment: Map<string, string>) => boolean,
): Promise<ServiceRuntimeConfig> {
  const declared: DeclaredContainerConfig = await loadDeclaredContainerConfig(executor, target);
  if (isComplete(declared.environment)) {
    return {
      environment: declared.environment,
      source: "kubernetes-config",
      captures: declared.captures,
    };
  }
  const runtime = await executor.exec(target, ["env"], { timeoutMs: 20_000 });
  const captures = [...declared.captures, runtime];
  if (!runtime.ok) {
    return {
      environment: declared.environment,
      source: "kubernetes-config",
      captures,
      reason: `声明配置不完整，且读取 Container env 失败：${failedExecReason(runtime)}`,
    };
  }
  const environment = new Map(declared.environment);
  for (const [name, value] of parseEnvironment(runtime.stdout)) environment.set(name, value);
  return { environment, source: "container-runtime", captures };
}
