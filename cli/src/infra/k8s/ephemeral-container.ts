import type { ExecResult, Executor } from "./executor";
import type { K8sMutation } from "./mutation";

export interface EphemeralContainerOptions {
  podName: string;
  targetContainer: string;
  containerName: string;
  image: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  command?: readonly string[];
  profile?: string;
  timeoutMs?: number;
}

export interface EphemeralContainerMutationOptions extends EphemeralContainerOptions {
  namespace: string;
  podJson: string;
  capabilities?: readonly string[];
  runAsUser?: number;
}

export interface EphemeralContainerFact {
  name: string;
  image: string;
  targetContainer: string;
  state: "running" | "waiting" | "terminated" | "unknown";
  capabilities: string[];
}

function ephemeralContainerState(status: any): EphemeralContainerFact["state"] {
  if (status?.state?.running) return "running";
  if (status?.state?.waiting) return "waiting";
  if (status?.state?.terminated) return "terminated";
  return "unknown";
}

/** 把 Kubernetes Pod API 形状收敛成能力层可消费的临时容器事实。 */
export function parseEphemeralContainers(
  podJson: string,
  targetContainer: string,
): EphemeralContainerFact[] {
  const pod = JSON.parse(podJson) as any;
  const statuses = new Map<string, any>(
    (pod.status?.ephemeralContainerStatuses ?? []).map((item: any) => [item.name, item]),
  );
  return (pod.spec?.ephemeralContainers ?? [])
    .filter((item: any) => item.targetContainerName === targetContainer)
    .map((item: any) => ({
      name: String(item.name ?? ""),
      image: String(item.image ?? ""),
      targetContainer: String(item.targetContainerName ?? ""),
      state: ephemeralContainerState(statuses.get(item.name)),
      capabilities: [...(item.securityContext?.capabilities?.add ?? [])],
    }));
}

/**
 * 用 ephemeralcontainers subresource 的原始 PUT 同时生成 dry-run 与真实提交命令。
 * 不走 `kubectl debug`：它没有 server dry-run，无法保证 Inspect 和 Probe 验证同一对象。
 */
export function buildEphemeralContainerMutation(
  options: EphemeralContainerMutationOptions,
): K8sMutation {
  const pod = JSON.parse(options.podJson) as any;
  const existing = Array.isArray(pod.spec?.ephemeralContainers)
    ? pod.spec.ephemeralContainers
    : [];
  pod.spec = {
    ...pod.spec,
    ephemeralContainers: [
      ...existing,
      {
        name: options.containerName,
        image: options.image,
        imagePullPolicy: options.imagePullPolicy ?? "IfNotPresent",
        targetContainerName: options.targetContainer,
        command: options.command ? [...options.command] : undefined,
        stdin: false,
        tty: false,
        securityContext: options.capabilities?.length || options.runAsUser !== undefined
          ? {
              capabilities: options.capabilities?.length
                ? { add: [...options.capabilities] }
                : undefined,
              runAsUser: options.runAsUser,
            }
          : undefined,
      },
    ],
  };
  const body = JSON.stringify(pod);
  const path = `/api/v1/namespaces/${encodeURIComponent(options.namespace)}`
    + `/pods/${encodeURIComponent(options.podName)}/ephemeralcontainers`;
  const command = (rawPath: string) => ({
    args: ["replace", "--raw", rawPath, "-f", "-"],
    stdin: body,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return {
    id: `ephemeral-container/${options.containerName}`,
    access: { verb: "update", resource: "pods/ephemeralcontainers" },
    dryRun: command(`${path}?dryRun=All`),
    execute: command(path),
  };
}

export function createEphemeralContainer(
  exec: Executor,
  options: EphemeralContainerOptions,
): Promise<ExecResult> {
  return exec.run([
    "debug",
    `pod/${options.podName}`,
    "--target",
    options.targetContainer,
    "--container",
    options.containerName,
    "--image",
    options.image,
    "--profile",
    options.profile ?? "general",
    "--attach=false",
    ...(options.command ? ["--", ...options.command] : []),
  ], { timeoutMs: options.timeoutMs ?? 60_000 });
}

function failedResult(result: ExecResult, reason: string, durationMs: number): ExecResult {
  return {
    ...result,
    ok: false,
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    stderr: [result.stderr.trim(), reason].filter(Boolean).join("\n"),
    durationMs,
  };
}

export async function waitForEphemeralContainerRunning(
  exec: Executor,
  podName: string,
  containerName: string,
  timeoutMs = 60_000,
): Promise<ExecResult> {
  const started = Date.now();
  while (true) {
    const result = await exec.run(["get", "pod", podName, "-o", "json"], { timeoutMs: 10_000 });
    const elapsed = Date.now() - started;
    if (!result.ok) return { ...result, durationMs: elapsed };
    try {
      const pod = JSON.parse(result.stdout) as any;
      const status = (pod.status?.ephemeralContainerStatuses ?? [])
        .find((item: any) => item.name === containerName);
      if (status?.state?.running) return { ...result, durationMs: elapsed };
      if (status?.state?.terminated) {
        const detail = status.state.terminated.reason
          ?? `exit=${status.state.terminated.exitCode ?? "unknown"}`;
        return failedResult(result, `临时调试容器已退出：${detail}`, elapsed);
      }
    } catch (error) {
      return failedResult(
        result,
        `Pod 状态解析失败：${error instanceof Error ? error.message : String(error)}`,
        elapsed,
      );
    }
    if (elapsed >= timeoutMs) {
      return failedResult(result, `等待临时调试容器运行超时（${timeoutMs}ms）`, elapsed);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
