import {
  inspectImageArchive,
  type ImageArchitecture,
  type ImageArchiveInfo,
  type ImagePlatform,
} from "../../infra/image";
import type { ImagePublishSource } from "./model";

const IMAGE_PLATFORM_SUFFIX = /-linux-(amd64|arm64)$/;

export function imagePlatformFromTag(image: string): ImagePlatform | undefined {
  const match = image.match(IMAGE_PLATFORM_SUFFIX);
  if (match?.[1] === "amd64" || match?.[1] === "arm64") {
    return { os: "linux", architecture: match[1] };
  }
  return undefined;
}

export function imageWithoutPlatformSuffix(image: string): string {
  return image.replace(IMAGE_PLATFORM_SUFFIX, "");
}

export function sourcePlatform(
  archive: ImageArchiveInfo,
  sourceImage: string,
): ImagePlatform | undefined {
  return archive.entries.find((entry) => entry.image === sourceImage)?.platform
    ?? imagePlatformFromTag(sourceImage);
}

export function currentHostArchitecture(): ImageArchitecture | undefined {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  return undefined;
}

export function matchingSourceImage(
  archive: ImageArchiveInfo,
  referenceSource: string,
): string | undefined {
  const logicalImage = imageWithoutPlatformSuffix(referenceSource);
  const matches = archive.images.filter(
    (image) => imageWithoutPlatformSuffix(image) === logicalImage,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function inspectPublishSource(
  archivePath: string,
  sourceImage: string,
): ImagePublishSource {
  const archive = inspectImageArchive(archivePath);
  if (!archive.images.includes(sourceImage)) {
    throw new Error(`image tar ${archivePath} 中找不到 source image：${sourceImage}`);
  }
  return {
    archive: archivePath,
    sourceImage,
    platform: sourcePlatform(archive, sourceImage),
  };
}

export function requireTaggedImage(image: string): void {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon <= slash) throw new Error(`目标镜像必须显式包含 tag：${image}`);
}

export function platformTargetImage(
  targetImage: string,
  platform: ImagePlatform,
): string {
  const slash = targetImage.lastIndexOf("/");
  const colon = targetImage.lastIndexOf(":");
  if (colon <= slash) {
    throw new Error(`目标镜像必须显式包含 tag：${targetImage}`);
  }
  return `${targetImage}-linux-${platform.architecture}`;
}

export function requireMultiArchitectureSources(
  sources: readonly ImagePublishSource[],
): Array<ImagePublishSource & { platform: ImagePlatform }> {
  if (sources.length !== 2) {
    throw new Error("原生 multi-arch 发布需要且仅支持 amd64、arm64 两个 image tar");
  }
  const complete = sources.filter(
    (source): source is ImagePublishSource & { platform: ImagePlatform } =>
      Boolean(source.platform),
  );
  if (complete.length !== sources.length) {
    throw new Error("无法从 image tar 元数据确定平台；不能安全创建 multi-arch image");
  }
  const logicalImages = new Set(
    complete.map((source) => imageWithoutPlatformSuffix(source.sourceImage)),
  );
  const architectures = new Set(
    complete.map((source) => source.platform.architecture),
  );
  if (
    logicalImages.size !== 1
    || architectures.size !== 2
    || !architectures.has("amd64")
    || !architectures.has("arm64")
  ) {
    throw new Error(
      "两个 image tar 必须属于同一 image/tag，并分别为 linux/amd64、linux/arm64",
    );
  }
  return complete.sort(
    (left, right) =>
      left.platform.architecture.localeCompare(right.platform.architecture),
  );
}

export function selectDoctorHostImage(
  sources: readonly ImagePublishSource[],
  architecture: ImageArchitecture | undefined = currentHostArchitecture(),
): ImagePublishSource | undefined {
  if (architecture) {
    const matching = sources.find(
      (source) => source.platform?.architecture === architecture,
    );
    if (matching) return matching;
  }
  return sources.length === 1 && !sources[0]!.platform
    ? sources[0]
    : undefined;
}

export function isPlatformSuffixedImage(image: string): boolean {
  return IMAGE_PLATFORM_SUFFIX.test(image);
}
