import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  inspectImageArchive,
  type ImageArchiveInfo,
} from "../../infra/image";
import { terminalStdout } from "../../terminal/output";
import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";
import type {
  ImageArchiveCandidate,
  ImagePublishSource,
  ResolveImageArchiveOptions,
  ResolveSourceImageOptions,
} from "./model";
import {
  imagePlatformFromTag,
  imageWithoutPlatformSuffix,
  inspectPublishSource,
  matchingSourceImage,
  sourcePlatform,
} from "./plan";

export function imageTarMissingMessage(path?: string): string {
  const missing = path
    ? `指定的 image tar 不存在：${path}`
    : "当前目录找不到 image tar";
  return `${missing}。\n`
    + "[image] image tar 是已经构建或导出的容器镜像离线归档；doctor image 可把它发布到 "
    + "Target Registry、load 到 Doctor Host，或同时准备到两处，不负责现场构建镜像。\n"
    + "[image] doctor-debug 可在 Doctor CLI 源码目录运行 `make build-debug-images` 生成；"
    + "其它镜像可用 `docker save` / `podman save` 导出。"
    + "请把产物复制到 Doctor Host 当前目录，或用 `--tar <path>` 指定。";
}

export function listImageArchives(
  directory: string = process.cwd(),
): ImageArchiveCandidate[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) =>
      entry.isFile() && entry.name.toLowerCase().endsWith(".tar")
    )
    .map((entry) => {
      const path = resolve(join(directory, entry.name));
      const stat = statSync(path);
      return {
        path,
        name: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path),
    );
}

function formatArchiveCandidate(
  candidate: ImageArchiveCandidate,
  newest: boolean,
): string {
  const sizeMiB = (candidate.size / 1024 / 1024).toFixed(1);
  const modified = new Date(candidate.mtimeMs).toLocaleString();
  return `${candidate.name}  ${sizeMiB} MiB  ${modified}`
    + `${newest ? "  [最新]" : ""}`;
}

async function selectImageArchive(
  candidates: readonly ImageArchiveCandidate[],
): Promise<ImageArchiveCandidate | undefined> {
  printNumberedChoices(
    candidates,
    "[image] 当前目录的 image tar：",
    (candidate) =>
      formatArchiveCandidate(candidate, candidate === candidates[0]),
  );
  return promptListedChoice({
    question: "选择 tar（序号/文件名，回车使用最新，q 取消）：",
    match: (answer) =>
      answer.trim() === ""
        ? candidates[0]
        : matchListedChoice(
            candidates,
            answer,
            (candidate) => candidate.name,
            (candidate) => candidate,
          ),
    invalidMessage: "输入无效，请选择列表中的序号或文件名。",
  });
}

export async function resolveImageArchive(
  explicit: string | undefined,
  options: ResolveImageArchiveOptions = {},
): Promise<string | undefined> {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(imageTarMissingMessage(explicit));
    }
    const path = resolve(explicit);
    terminalStdout.info(`[image] tar: ${path}（--tar）\n`);
    return path;
  }

  const candidates = listImageArchives(options.directory);
  if (candidates.length === 0) {
    throw new Error(imageTarMissingMessage());
  }
  if (candidates.length === 1) {
    terminalStdout.info(
      `[image] tar: ${candidates[0]!.path}（当前目录唯一候选，自动选择）\n`,
    );
    return candidates[0]!.path;
  }
  const interactive = options.interactive
    ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error("当前目录找到多个 image tar，非交互环境请用 --tar 明确指定");
  }
  const selected = await (options.select ?? selectImageArchive)(candidates);
  if (!selected) return undefined;
  terminalStdout.info(`[image] tar: ${selected.path}（交互选择）\n`);
  return selected.path;
}

export async function resolveImageArchives(
  explicit: string | string[] | undefined,
  options: ResolveImageArchiveOptions = {},
): Promise<string[] | undefined> {
  const paths = (
    Array.isArray(explicit)
      ? explicit
      : explicit
        ? [explicit]
        : []
  ).map((path) => resolve(path));
  if (paths.length === 0) {
    const selected = await resolveImageArchive(undefined, options);
    return selected ? [selected] : undefined;
  }
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(imageTarMissingMessage(path));
    terminalStdout.info(`[image] tar: ${path}（--tar）\n`);
  }
  return [...new Set(paths)];
}

async function selectSourceImage(
  images: readonly string[],
): Promise<string | undefined> {
  printNumberedChoices(
    images,
    "[image] tar 中包含多个 image：",
    (image) => image,
  );
  return promptListedChoice({
    question: "选择要发布的 image（序号/名称，回车使用第一个，q 取消）：",
    match: (answer) =>
      answer.trim() === ""
        ? images[0]
        : matchListedChoice(
            images,
            answer,
            (image) => image,
            (image) => image,
          ),
    invalidMessage: "输入无效，请选择列表中的序号或 image 名称。",
  });
}

export async function resolveSourceImage(
  archive: ImageArchiveInfo,
  explicit: string | undefined,
  options: ResolveSourceImageOptions = {},
): Promise<string | undefined> {
  if (explicit) {
    if (!archive.images.includes(explicit)) {
      throw new Error(`--source-image 不在 tar 的 image 列表中：${explicit}`);
    }
    terminalStdout.info(`[image] source: ${explicit}（--source-image）\n`);
    return explicit;
  }
  if (archive.images.length === 1) {
    terminalStdout.info(
      `[image] source: ${archive.images[0]}（tar 元数据）\n`,
    );
    return archive.images[0];
  }
  const interactive = options.interactive
    ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(
      "tar 中包含多个 image，非交互环境请用 --source-image 明确指定："
      + archive.images.join("、"),
    );
  }
  return (options.select ?? selectSourceImage)(archive.images);
}

export async function resolvePublishSources(
  archivePaths: readonly string[],
  explicitSource: string | undefined,
  interactive: boolean,
): Promise<ImagePublishSource[] | undefined> {
  const primaryArchive = inspectImageArchive(archivePaths[0]!);
  const primaryImage = await resolveSourceImage(
    primaryArchive,
    explicitSource,
    { interactive },
  );
  if (!primaryImage) return undefined;
  const sources = [{
    archive: archivePaths[0]!,
    sourceImage: primaryImage,
    platform: sourcePlatform(primaryArchive, primaryImage),
  }];

  for (const archivePath of archivePaths.slice(1)) {
    const archive = inspectImageArchive(archivePath);
    const sourceImage = matchingSourceImage(archive, primaryImage);
    if (!sourceImage) {
      throw new Error(
        `image tar ${archivePath} 中找不到与 ${primaryImage} 对应的唯一平台镜像`,
      );
    }
    sources.push({
      archive: archivePath,
      sourceImage,
      platform: sourcePlatform(archive, sourceImage),
    });
  }
  return sources;
}

export function findPlatformCompanion(
  source: ImagePublishSource,
): ImagePublishSource | undefined {
  if (!source.platform) return undefined;
  const candidates: ImagePublishSource[] = [];
  for (const candidate of listImageArchives(dirname(source.archive))) {
    if (candidate.path === source.archive) continue;
    try {
      const archive = inspectImageArchive(candidate.path);
      for (const entry of archive.entries) {
        const platform = entry.platform ?? imagePlatformFromTag(entry.image);
        if (
          platform
          && platform.architecture !== source.platform.architecture
          && imageWithoutPlatformSuffix(entry.image)
            === imageWithoutPlatformSuffix(source.sourceImage)
        ) {
          candidates.push(inspectPublishSource(candidate.path, entry.image));
        }
      }
    } catch {
      // Current directories may also contain package bundles or unrelated tar files.
    }
  }
  if (candidates.length !== 1) return undefined;
  terminalStdout.info(
    `[image] 配对 tar: ${candidates[0]!.archive}`
    + `（${candidates[0]!.platform?.os}/`
    + `${candidates[0]!.platform?.architecture}）\n`,
  );
  return candidates[0];
}
