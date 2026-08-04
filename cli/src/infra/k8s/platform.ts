import type { ImageArchitecture, ImagePlatform } from "../image";
import type { Executor } from "./executor";

export interface PodImagePlatform {
  platform?: ImagePlatform;
  node?: string;
  reason?: string;
}

export function normalizeImageArchitecture(value: string | undefined): ImageArchitecture | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "amd64" || normalized === "x86_64") return "amd64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return undefined;
}

export function parseNodeImagePlatform(raw: string): ImagePlatform | undefined {
  const node = JSON.parse(raw) as Record<string, any>;
  const architecture = normalizeImageArchitecture(
    node.metadata?.labels?.["kubernetes.io/arch"] ?? node.status?.nodeInfo?.architecture,
  );
  return architecture ? { os: "linux", architecture } : undefined;
}

/** Only a repository-qualified digest can safely identify the image actually selected by Kubelet. */
export function pullableImageReference(imageId: string | undefined): string | undefined {
  const reference = imageId?.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (!reference || !/@sha256:[0-9a-f]{64}$/i.test(reference) || !reference.includes("/")) {
    return undefined;
  }
  return reference;
}

/** Node lookup is best-effort: a multi-arch image remains safe when nodes/get is unavailable. */
export async function inspectPodImagePlatform(
  executor: Executor,
  nodeName: string | undefined,
): Promise<PodImagePlatform> {
  if (!nodeName) return { reason: "Pod 尚未调度到 Node" };
  const result = await executor.run(["get", "node", nodeName, "-o", "json"], { timeoutMs: 10_000 });
  if (!result.ok) {
    const reason = result.stderr.trim() || result.stdout.trim() || "Node 信息不可读";
    return { node: nodeName, reason };
  }
  try {
    const platform = parseNodeImagePlatform(result.stdout);
    return platform
      ? { node: nodeName, platform }
      : { node: nodeName, reason: "Node architecture 不是 amd64/arm64" };
  } catch (error) {
    return {
      node: nodeName,
      reason: `Node JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
