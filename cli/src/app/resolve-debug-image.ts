import type {
  ImagePlatform,
  RegistryCredentials,
  RegistryTagListResult,
} from "../infra/image";
import toolkitVersion from "../../../toolkit/VERSION" with { type: "text" };
import { resolveCollectDebugImage } from "../infra/k8s/context";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";
import { listRegistryTagsWithAuth } from "./registry-auth";
import type { CommandProfile } from "../command";

// Debug image repository 的单一来源；Makefile 构建默认值也从本常量读取。
export const DOCTOR_DEBUG_IMAGE = "doctor-debug";
// VERSION 同时驱动镜像构建 tag 与 CLI 默认选择，避免 CLI/image 发布节奏被迫绑定。
export const DOCTOR_DEBUG_IMAGE_VERSION = toolkitVersion.trim();

export interface ResolvedDebugImage {
  image: string;
  source: "flag" | `profile:${string}` | "inferred" | "discovered" | "target-image";
  credentials?: RegistryCredentials;
}

interface DebugImageResolutionOpts {
  image?: string;
  profile?: string;
  config?: string;
}

interface ResolveDebugImageOptions {
  interactive?: boolean;
  platform?: ImagePlatform;
  listTags?: (
    repository: string,
    options?: { promptIfUnauthorized?: boolean },
  ) => Promise<RegistryTagListResult & { credentials?: RegistryCredentials }>;
  discoverRepositories?: () => Promise<readonly string[]>;
  selectImage?: (images: readonly string[]) => Promise<string | undefined>;
  profile?: CommandProfile;
}

export function appendImageTagSuffix(image: string, suffix: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon <= slash) throw new Error("目标镜像必须显式包含 tag，例如 registry/ns/doctor-debug:0.0.8");
  return `${image.slice(0, colon + 1)}${image.slice(colon + 1)}-${suffix}`;
}

export function inferDebugImage(targetImage: string, version: string): string {
  return `${inferDebugImageRepository(targetImage)}:${version}`;
}

export function inferDebugImageRepository(targetImage: string): string {
  const withoutDigest = targetImage.split("@", 1)[0]!;
  const slash = withoutDigest.lastIndexOf("/");
  if (slash < 0) throw new Error(`无法从目标容器镜像推断 registry/namespace：${targetImage}`);
  const repository = withoutDigest.slice(0, slash);
  if (!repository.includes("/") && !/[.:]/.test(repository)) {
    throw new Error(`目标镜像没有显式 registry，无法安全推断发布位置：${targetImage}`);
  }
  return `${repository}/${DOCTOR_DEBUG_IMAGE}`;
}

function prioritizeDebugImageTags(tags: readonly string[], platform?: ImagePlatform): string[] {
  const preferred = [
    DOCTOR_DEBUG_IMAGE_VERSION,
    platform ? `${DOCTOR_DEBUG_IMAGE_VERSION}-${platform.os}-${platform.architecture}` : undefined,
  ].filter((tag): tag is string => Boolean(tag));
  const unique = [...new Set(tags)];
  return [
    ...preferred.filter((tag) => unique.includes(tag)),
    ...unique.filter((tag) => !preferred.includes(tag)),
  ];
}

async function selectDebugImage(
  choices: readonly string[],
  targetImage: string,
): Promise<string | undefined> {
  const targetChoice = targetImageChoice(targetImage);
  printNumberedChoices(
    choices,
    "[debug] 可用于 debug container 的 image：",
    (choice) => choice,
  );
  return promptListedChoice({
    question: `选择 image（序号/完整名称，回车使用 ${choices[0]}，q 取消）：`,
    match: (answer) => {
      const value = answer.trim();
      if (value === "") return choices[0];
      if (value === targetImage) return targetChoice;
      return matchListedChoice(choices, answer, (choice) => choice, (choice) => choice);
    },
    invalidMessage: "输入无效，请选择列表中的序号或完整名称。",
  });
}

function targetImageChoice(targetImage: string): string {
  return `复用目标业务镜像：${targetImage}`;
}

export async function resolveDebugImage(
  targetImage: string,
  opts: DebugImageResolutionOpts,
  options: ResolveDebugImageOptions = {},
): Promise<ResolvedDebugImage | undefined> {
  const configured = resolveCollectDebugImage({
    debugImage: opts.image,
    profile: opts.profile,
    config: opts.config,
  }, options.profile);
  if (configured.image && configured.source !== "unconfigured") {
    return { image: configured.image, source: configured.source };
  }
  const repository = inferDebugImageRepository(targetImage);
  const interactive = options.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return {
      image: inferDebugImage(targetImage, DOCTOR_DEBUG_IMAGE_VERSION),
      source: "inferred",
    };
  }

  const discovered = await options.discoverRepositories?.() ?? [];
  const repositories = [...new Set([repository, ...discovered])];
  const available: Array<{ image: string; credentials?: RegistryCredentials }> = [];
  const failures: string[] = [];
  const unauthorized: string[] = [];
  const listTags = options.listTags
    ?? ((value, listOptions) => listRegistryTagsWithAuth(value, opts, listOptions));

  const appendAvailable = (
    candidate: string,
    listed: RegistryTagListResult & { credentials?: RegistryCredentials },
  ): void => {
    for (const tag of prioritizeDebugImageTags(listed.tags, options.platform)) {
      available.push({ image: `${candidate}:${tag}`, credentials: listed.credentials });
    }
  };

  for (const candidate of repositories) {
    const listed = await listTags(candidate, { promptIfUnauthorized: false });
    if (listed.state === "ready") {
      appendAvailable(candidate, listed);
    } else if (listed.state === "unauthorized") {
      unauthorized.push(candidate);
    } else if (listed.state !== "missing") {
      failures.push(`${candidate}: ${listed.state}`);
    }
  }
  // A private candidate must not interrupt discovery when another namespace repository is readable.
  // Only fall back to interactive authentication when the silent scan found no usable image.
  if (available.length === 0) {
    for (const candidate of unauthorized) {
      const listed = await listTags(candidate, { promptIfUnauthorized: true });
      if (listed.state === "ready") {
        appendAvailable(candidate, listed);
        break;
      }
      if (listed.state !== "missing") failures.push(`${candidate}: ${listed.state}`);
    }
  }
  if (available.length === 0) {
    if (failures.length > 0) throw new Error(`registry tag 列表读取失败：${failures.join("；")}`);
    throw new Error(`当前 Kubernetes namespace 的 ${DOCTOR_DEBUG_IMAGE} repository 均无可用 tag；请先用 doctor image 发布`);
  }
  const images = available.map((candidate) => candidate.image);
  const targetChoice = targetImageChoice(targetImage);
  const choices = [...images, targetChoice];
  const selected = options.selectImage
    ? await options.selectImage(choices)
    : await selectDebugImage(choices, targetImage);
  if (!selected) return undefined;
  if (selected === targetChoice) {
    return {
      image: targetImage,
      source: "target-image",
    };
  }
  const selectedCandidate = available.find((candidate) => candidate.image === selected);
  return {
    image: selected,
    source: "discovered",
    credentials: selectedCandidate?.credentials,
  };
}

export function debugImageDescription(resolved: ResolvedDebugImage): string {
  if (resolved.source === "flag") return `${resolved.image}（--image）`;
  if (resolved.source.startsWith("profile:")) {
    return `${resolved.image}（${resolved.source} kube.debug_image）`;
  }
  if (resolved.source === "target-image") return `${resolved.image}（复用目标业务镜像）`;
  return resolved.source === "discovered"
    ? `${resolved.image}（从当前 Kubernetes namespace 发现）`
    : `${resolved.image}（从目标业务镜像推断）`;
}
