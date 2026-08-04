import { closeSync, openSync, readSync } from "node:fs";
import type { ImagePlatform } from "./registry";

export interface ImageArchiveEntry {
  image: string;
  platform?: ImagePlatform;
}

export interface ImageArchiveInfo {
  images: string[];
  entries: ImageArchiveEntry[];
}

const TAR_BLOCK_SIZE = 512;
const MAX_METADATA_SIZE = 8 * 1024 * 1024;

function tarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end >= start && end < start + length ? end : start + length).trim();
}

function readTarMetadata(path: string, names: ReadonlySet<string>): Map<string, string> {
  const fd = openSync(path, "r");
  const found = new Map<string, string>();
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  let offset = 0;
  try {
    while (readSync(fd, header, 0, TAR_BLOCK_SIZE, offset) === TAR_BLOCK_SIZE) {
      if (header.every((value) => value === 0)) break;
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const fullName = prefix ? `${prefix}/${name}` : name;
      const sizeText = tarString(header, 124, 12).replace(/^0+/, "") || "0";
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isFinite(size) || size < 0) throw new Error(`image tar entry size 无效：${fullName}`);
      const dataOffset = offset + TAR_BLOCK_SIZE;
      if (names.has(fullName)) {
        if (size > MAX_METADATA_SIZE) throw new Error(`image tar 元数据过大：${fullName}`);
        const data = Buffer.alloc(size);
        if (readSync(fd, data, 0, size, dataOffset) !== size) {
          throw new Error(`image tar 元数据读取不完整：${fullName}`);
        }
        found.set(fullName, data.toString("utf8"));
        if (found.size === names.size) break;
      }
      offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }
  } finally {
    closeSync(fd);
  }
  return found;
}

function parsePlatform(value: unknown): ImagePlatform | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const os = typeof record.os === "string" ? record.os.toLowerCase() : undefined;
  const architecture = typeof record.architecture === "string"
    ? record.architecture.toLowerCase()
    : undefined;
  if (os !== "linux") return undefined;
  if (architecture === "amd64" || architecture === "x86_64") {
    return { os: "linux", architecture: "amd64" };
  }
  if (architecture === "arm64" || architecture === "aarch64") {
    return { os: "linux", architecture: "arm64" };
  }
  return undefined;
}

function dockerArchiveEntries(
  path: string,
  manifest: string | undefined,
): ImageArchiveEntry[] {
  if (!manifest) return [];
  const records = JSON.parse(manifest) as Array<{ Config?: unknown; RepoTags?: unknown }>;
  if (!Array.isArray(records)) throw new Error("manifest.json 不是 Docker image archive manifest");
  const configNames = new Set(records.flatMap((record) =>
    typeof record.Config === "string" && record.Config ? [record.Config] : []));
  const configs = readTarMetadata(path, configNames);
  return records.flatMap((record) => {
    const images = Array.isArray(record.RepoTags)
      ? record.RepoTags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
      : [];
    let platform: ImagePlatform | undefined;
    if (typeof record.Config === "string") {
      const config = configs.get(record.Config);
      if (config) platform = parsePlatform(JSON.parse(config));
    }
    return images.map((image) => ({ image, platform }));
  });
}

function ociArchiveEntries(index: string | undefined): ImageArchiveEntry[] {
  if (!index) return [];
  const value = JSON.parse(index) as {
    manifests?: Array<{
      annotations?: Record<string, unknown>;
      platform?: unknown;
    }>;
  };
  if (!Array.isArray(value.manifests)) return [];
  return value.manifests.flatMap((manifest) => {
    const annotations = manifest.annotations ?? {};
    const name = annotations["io.containerd.image.name"] ?? annotations["org.opencontainers.image.ref.name"];
    return typeof name === "string" && name.trim()
      ? [{ image: name, platform: parsePlatform(manifest.platform) }]
      : [];
  });
}

export function inspectImageArchive(path: string): ImageArchiveInfo {
  let metadata: Map<string, string>;
  try {
    metadata = readTarMetadata(path, new Set(["manifest.json", "index.json"]));
  } catch (err) {
    throw new Error(`无法读取 image tar ${path}：${err instanceof Error ? err.message : String(err)}`);
  }
  let entries: ImageArchiveEntry[];
  try {
    entries = dockerArchiveEntries(path, metadata.get("manifest.json"));
    if (entries.length === 0) entries = ociArchiveEntries(metadata.get("index.json"));
  } catch (err) {
    throw new Error(`无法解析 image tar ${path}：${err instanceof Error ? err.message : String(err)}`);
  }
  const unique = new Map<string, ImageArchiveEntry>();
  for (const entry of entries) {
    const previous = unique.get(entry.image);
    if (!previous?.platform || entry.platform) unique.set(entry.image, entry);
  }
  entries = [...unique.values()].sort((left, right) => left.image.localeCompare(right.image));
  const images = entries.map((entry) => entry.image);
  if (images.length === 0) {
    throw new Error(`image tar 中找不到可发布的 image 名称：${path}`);
  }
  return { images, entries };
}
