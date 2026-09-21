import { inspectRegistryAccess } from "../../app/registry-auth";
import { infra } from "../../infra";
import type { RegistryCredentials } from "../../infra/image";

import { useLogger } from "../../terminal/log";
import type {
  ImageCliOpts,
  ImagePublishSource,
} from "./model";
import {
  isPlatformSuffixedImage,
  platformTargetImage,
  requireMultiArchitectureSources,
  requireTaggedImage,
} from "./plan";

async function resolvePublishAccess(
  targetImage: string,
  opts: ImageCliOpts,
): Promise<RegistryCredentials | undefined | false> {
  const access = await inspectRegistryAccess(
    targetImage,
    opts,
    undefined,
    "publish-image",
  );
  if (access.state === "ready" || access.state === "missing") {
    return access.credentials;
  }
  useLogger("image").error(`registry access failed: ${access.state} (${targetImage})`);
  return false;
}

function importImage(
  targetImage: string,
  source: ImagePublishSource,
  credentials?: RegistryCredentials,
): boolean {
  if (!infra.image.import(
    targetImage,
    source.archive,
    credentials,
    { sourceImage: source.sourceImage },
  )) {
    return false;
  }
  useLogger("image").success(`published: ${targetImage}`);
  return true;
}

/** Publish one image from a local Docker/OCI archive to an explicit registry reference. */
export async function publishImage(
  targetImage: string,
  archive: string,
  sourceImage: string,
  opts: ImageCliOpts,
): Promise<number> {
  requireTaggedImage(targetImage);
  const credentials = await resolvePublishAccess(targetImage, opts);
  if (credentials === false) return 1;
  return importImage(
    targetImage,
    { archive, sourceImage },
    credentials,
  )
    ? 0
    : 1;
}

/** Publish platform children first, then expose one native OCI index to Kubernetes. */
export async function publishMultiArchitectureImage(
  targetImage: string,
  sources: readonly ImagePublishSource[],
  opts: ImageCliOpts,
): Promise<number> {
  requireTaggedImage(targetImage);
  if (isPlatformSuffixedImage(targetImage)) {
    throw new Error(
      `multi-arch 目标 tag 不应包含平台后缀：${targetImage}；`
      + "若只发布单架构，请用 --tar 显式指定一份 tar",
    );
  }
  const complete = requireMultiArchitectureSources(sources);
  const credentials = await resolvePublishAccess(targetImage, opts);
  if (credentials === false) return 1;
  const children = complete.map((source) => ({
    source,
    targetImage: platformTargetImage(targetImage, source.platform),
  }));
  useLogger("image").info("Target Registry 将发布：");
  for (const child of children) {
    useLogger().info(`  ${child.targetImage}`
      + `（${child.source.platform.os}/${child.source.platform.architecture}）`);
  }
  useLogger().info(`  ${targetImage}（multi-arch OCI index）`);

  for (const child of children) {
    if (!importImage(child.targetImage, child.source, credentials)) return 1;
  }
  const refs = children.map((child) => child.targetImage);
  if (!infra.image.createIndex(targetImage, refs, credentials)) return 1;
  if (!infra.image.verifyIndex(targetImage, credentials)) {
    useLogger("image").error(`multi-arch index 验证失败：${targetImage}`);
    return 1;
  }
  for (const source of complete) {
    const state = infra.image.inspect(
      targetImage,
      credentials,
      source.platform,
    );
    if (state !== "ready") {
      useLogger("image").error(`multi-arch platform 验证失败：${targetImage}`
        + ` (${source.platform.os}/${source.platform.architecture}, ${state})`);
      return 1;
    }
  }
  useLogger("image").success(`published multi-arch: ${targetImage}`);
  return 0;
}
