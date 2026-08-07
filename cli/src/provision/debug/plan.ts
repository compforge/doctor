import { discoverRegistryCatalog } from "../../app/image-target";
import { inspectRegistryAccess } from "../../app/registry-auth";
import {
  appendImageTagSuffix,
  debugImageDescription,
  DOCTOR_DEBUG_IMAGE,
  resolveDebugImage,
} from "../../app/resolve-debug-image";
import { infra } from "../../infra";
import type { ImagePlatform } from "../../infra/image";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { inspectTargetImagePlatform, reportTargetPlatform } from "./inspect";
import type {
  BatchDebugImageResolution,
  DebugCliOpts,
  DebugPlatformSource,
  DebugTarget,
  PreparedDebugImage,
} from "./model";

export async function resolveBatchDebugImage(
  cache: Map<string, Promise<PreparedDebugImage>>,
  platform: ImagePlatform,
  prepare: () => Promise<PreparedDebugImage>,
): Promise<BatchDebugImageResolution> {
  const key = `${platform.os}/${platform.architecture}`;
  const cached = cache.get(key);
  if (cached) return { prepared: await cached, reused: true };

  const pending = prepare();
  cache.set(key, pending);
  const prepared = await pending;
  // Target-image fallback contains image-specific bootstrap/tooling facts and must be
  // reprobed for every Pod even when the CPU architecture is shared.
  if (prepared.source === "target-image") cache.delete(key);
  return { prepared, reused: false };
}

async function discoverDebugImageRepositories(target: DebugTarget): Promise<string[]> {
  const kubernetes = target.context.kubernetes(target.executor);
  const discovery = await enforceKubernetesAccess(kubernetes.access, {
    command: "doctor debug",
    needs: [{
      requirement: "preferred",
      rule: { verb: "list", resource: "pods" },
      purpose: "从当前 Namespace 的业务镜像发现 Registry repository",
      fallback: "回退目标业务镜像路径",
    }],
  });
  if (discovery.facts[0]?.status === "denied") return [];
  try {
    const catalog = await discoverRegistryCatalog({}, target.executor, {
      allNamespaces: false,
      access: kubernetes.access,
      channelChecked: true,
    });
    return catalog.registries.flatMap((registry) =>
      (catalog.namespacesByRegistry[registry] ?? []).map(
        (namespace) => `${registry}/${namespace}/${DOCTOR_DEBUG_IMAGE}`,
      )
    );
  } catch (error) {
    terminalStdout.warning(
      "[debug] 当前 Kubernetes namespace 的 image repository 发现失败："
      + `${error instanceof Error ? error.message : String(error)}；`
      + "回退目标业务镜像路径。\n",
    );
    return [];
  }
}

async function prepareTargetImage(
  target: DebugTarget,
  fallbackReason: string | undefined,
  platformSource: DebugPlatformSource | undefined,
  platformReported: boolean,
): Promise<PreparedDebugImage> {
  if (!platformReported) reportTargetPlatform(target, platformSource);
  if (fallbackReason) {
    terminalStdout.warning(
      `[debug] doctor debug image 不可用：${fallbackReason}\n`
      + `[debug] 回退目标业务镜像 ${target.containerImage}，只保证基础 ptrace container\n`,
    );
  } else {
    terminalStdout.write(
      `[debug] 复用目标业务镜像 ${target.containerImage}，只保证基础 ptrace container\n`,
    );
  }
  const bootstrap = await infra.target.debugEngine.resolveTargetImageKeepalive(
    target.executor,
    target.pod,
    target.container,
  );
  if (!bootstrap) {
    terminalStderr.error(
      "[debug] 目标业务镜像中未找到安全常驻命令（需要 sleep 或 python3）；"
      + "为避免启动第二份业务进程，未创建临时容器\n",
    );
    return { code: 1 };
  }
  terminalStdout.write(
    `[debug] target-image keepalive: ${bootstrap.description}；不会运行业务 ENTRYPOINT/CMD\n`,
  );
  return {
    code: 0,
    source: "target-image",
    image: target.containerImage,
    imagePullPolicy: "Never",
    command: bootstrap.command,
  };
}

export async function prepareDebugImage(
  target: DebugTarget,
  opts: DebugCliOpts,
  platformSource: DebugPlatformSource | undefined,
  platformReported: boolean,
): Promise<PreparedDebugImage> {
  let resolvedImage;
  try {
    resolvedImage = await resolveDebugImage(target.containerImage, opts, {
      platform: target.imagePlatform,
      profile: target.context.profile,
      discoverRepositories: () => discoverDebugImageRepositories(target),
    });
  } catch (error) {
    return prepareTargetImage(
      target,
      error instanceof Error ? error.message : String(error),
      platformSource,
      platformReported,
    );
  }
  if (!resolvedImage) return { code: 130 };
  if (resolvedImage.source === "target-image") {
    return prepareTargetImage(target, undefined, platformSource, platformReported);
  }
  const image = resolvedImage.image;
  let access = resolvedImage.credentials
    ? {
        state: infra.image.inspect(
          image,
          resolvedImage.credentials,
          target.imagePlatform,
        ),
        credentials: resolvedImage.credentials,
      }
    : await inspectRegistryAccess(image, opts, target.imagePlatform);
  // Interactive credentials obtained for the inferred registry may unlock the exact business image digest too.
  if (!target.imagePlatform && access.credentials) {
    target.imagePlatform = inspectTargetImagePlatform(target, access.credentials);
    if (target.imagePlatform) {
      platformSource = "image-manifest";
      access = {
        ...access,
        state: infra.image.inspect(image, access.credentials, target.imagePlatform),
      };
    }
  }
  if (!platformReported) reportTargetPlatform(target, platformSource);
  terminalStdout.write(`[debug] image: ${debugImageDescription(resolvedImage)}\n`);

  let deployImage = image;
  if (access.state === "missing" && target.imagePlatform) {
    const arch = target.imagePlatform.architecture;
    const suffix = `linux-${arch}`;
    const archImage = image.endsWith(`-${suffix}`)
      ? image
      : appendImageTagSuffix(image, suffix);
    const archState = infra.image.inspect(
      archImage,
      access.credentials,
      target.imagePlatform,
    );
    if (archState === "ready") {
      access = { ...access, state: "ready" };
      deployImage = archImage;
    } else if (archState === "missing") {
      deployImage = archImage;
    } else {
      return prepareTargetImage(
        target,
        `registry image check failed: ${archState} (${archImage})`,
        platformSource,
        true,
      );
    }
  }

  if (access.state === "missing") {
    return prepareTargetImage(
      target,
      `registry image 不存在：${deployImage}`,
      platformSource,
      true,
    );
  }
  if (access.state !== "ready") {
    return prepareTargetImage(
      target,
      `registry image check failed: ${access.state} (${image})`,
      platformSource,
      true,
    );
  }
  return {
    code: 0,
    source: "debug-image",
    image: deployImage,
    imagePullPolicy: "IfNotPresent",
  };
}
