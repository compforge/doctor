import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ToolkitArchive,
  ToolkitArchitecture,
  ToolkitManifest,
  ToolkitOs,
  ToolkitPlatformManifest,
  ToolkitResource,
} from "./model";

const TAR_BLOCK_SIZE = 512;
const TOOLKIT_ROOT = "doctor-toolkit/";
const MANIFEST_PATH = `${TOOLKIT_ROOT}manifest.json`;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;

interface TarEntry {
  readonly name: string;
  readonly dataOffset: number;
  readonly size: number;
  readonly type: string;
}

function tarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  return buffer
    .toString("utf8", start, end >= start && end < start + length ? end : start + length)
    .trim();
}

function safeEntryName(name: string): boolean {
  return Boolean(name)
    && !name.startsWith("/")
    && !name.split("/").some((part) => part === "..");
}

function scanToolkitArchive(path: string): Map<string, TarEntry> {
  const entries = new Map<string, TarEntry>();
  const fd = openSync(path, "r");
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  let offset = 0;
  try {
    while (readSync(fd, header, 0, TAR_BLOCK_SIZE, offset) === TAR_BLOCK_SIZE) {
      if (header.every((value) => value === 0)) break;
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const fullName = prefix ? `${prefix}/${name}` : name;
      if (!safeEntryName(fullName) || !fullName.startsWith(TOOLKIT_ROOT)) {
        throw new Error(`Toolkit 包含不安全或越界条目：${fullName}`);
      }
      const type = header[156] === 0 ? "" : String.fromCharCode(header[156]!);
      if (!["", "0", "5"].includes(type)) {
        throw new Error(`Toolkit 不允许 link 或特殊条目：${fullName}`);
      }
      const sizeText = tarString(header, 124, 12).replace(/^0+/, "") || "0";
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error(`Toolkit 条目大小无效：${fullName}`);
      }
      if (entries.has(fullName)) throw new Error(`Toolkit 包含重复条目：${fullName}`);
      const dataOffset = offset + TAR_BLOCK_SIZE;
      entries.set(fullName, { name: fullName, dataOffset, size, type });
      offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }
  } finally {
    closeSync(fd);
  }
  return entries;
}

function readEntry(path: string, entry: TarEntry, maxBytes: number): Buffer {
  if (entry.type === "5") throw new Error(`Toolkit 条目不是文件：${entry.name}`);
  if (entry.size > maxBytes) throw new Error(`Toolkit 条目过大：${entry.name}`);
  const data = Buffer.alloc(entry.size);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, data, 0, entry.size, entry.dataOffset) !== entry.size) {
      throw new Error(`Toolkit 条目读取不完整：${entry.name}`);
    }
  } finally {
    closeSync(fd);
  }
  return data;
}

function parseResource(value: unknown, platform: string): ToolkitResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Toolkit ${platform} resource 无效`);
  }
  const resource = value as Record<string, unknown>;
  if (
    typeof resource.id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(resource.id)
  ) {
    throw new Error(`Toolkit ${platform} resource id 无效`);
  }
  if (
    typeof resource.path !== "string"
    || !resource.path.startsWith(`${TOOLKIT_ROOT}platforms/${platform}/`)
    || !safeEntryName(resource.path)
  ) {
    throw new Error(`Toolkit resource path 无效：${String(resource.path)}`);
  }
  if (typeof resource.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(resource.sha256)) {
    throw new Error(`Toolkit resource sha256 无效：${resource.id}`);
  }
  if (!Number.isSafeInteger(resource.size) || (resource.size as number) < 0) {
    throw new Error(`Toolkit resource size 无效：${resource.id}`);
  }
  return resource as unknown as ToolkitResource;
}

function parsePlatform(value: unknown): ToolkitPlatformManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Toolkit platform 无效");
  }
  const platform = value as Record<string, unknown>;
  const os = platform.os as ToolkitOs;
  const architecture = platform.architecture as ToolkitArchitecture;
  if (!(["darwin", "linux"] as const).includes(os)) {
    throw new Error(`Toolkit os 不支持：${String(platform.os)}`);
  }
  if (!(["amd64", "arm64"] as const).includes(architecture)) {
    throw new Error(`Toolkit architecture 不支持：${String(platform.architecture)}`);
  }
  const platformId = `${os}-${architecture}`;
  const parseResources = (field: "tools" | "images" | "packages") => {
    const raw = platform[field];
    if (!Array.isArray(raw)) throw new Error(`Toolkit ${platformId}.${field} 无效`);
    const resources = raw.map((item) => parseResource(item, platformId));
    if (new Set(resources.map((item) => item.id)).size !== resources.length) {
      throw new Error(`Toolkit ${platformId}.${field} id 重复`);
    }
    return resources;
  };
  return {
    os,
    architecture,
    tools: parseResources("tools"),
    images: parseResources("images"),
    packages: parseResources("packages"),
  };
}

export function parseToolkitManifest(raw: string): ToolkitManifest {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.schema !== "doctor.toolkit/v1") {
    throw new Error(`不支持的 Toolkit schema：${String(value.schema)}`);
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("Toolkit manifest 缺少 version");
  }
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    throw new Error("Toolkit manifest platforms 无效");
  }
  const platforms = value.platforms.map(parsePlatform);
  const ids = platforms.map((item) => `${item.os}/${item.architecture}`);
  if (new Set(ids).size !== ids.length) throw new Error("Toolkit platform 重复");
  return { schema: "doctor.toolkit/v1", version: value.version, platforms };
}

export function inspectToolkitArchive(path: string): ToolkitArchive {
  const absolute = resolve(path);
  if (!statSync(absolute).isFile()) throw new Error(`Toolkit 不是文件：${path}`);
  try {
    const entries = scanToolkitArchive(absolute);
    const manifestEntry = entries.get(MANIFEST_PATH);
    if (!manifestEntry) throw new Error(`缺少 ${MANIFEST_PATH}`);
    const manifest = parseToolkitManifest(
      readEntry(absolute, manifestEntry, MAX_MANIFEST_BYTES).toString("utf8"),
    );
    for (const platform of manifest.platforms) {
      for (const resource of [...platform.tools, ...platform.images, ...platform.packages]) {
        const entry = entries.get(resource.path);
        if (!entry || entry.type === "5") throw new Error(`缺少 Toolkit resource：${resource.path}`);
        if (entry.size !== resource.size) throw new Error(`Toolkit resource size 不匹配：${resource.path}`);
      }
    }
    return { path: absolute, manifest };
  } catch (error) {
    throw new Error(
      `无法读取 Doctor Toolkit ${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

let materializedRoot: string | undefined;
const materialized = new Map<string, string>();

function materializationRoot(): string {
  materializedRoot ??= mkdtempSync(join(tmpdir(), "doctor-toolkit-"));
  return materializedRoot;
}

export function materializeToolkitResource(
  archive: ToolkitArchive,
  resource: ToolkitResource,
  executable = false,
): string {
  const key = `${archive.path}\0${resource.path}`;
  const previous = materialized.get(key);
  if (previous) return previous;
  const entries = scanToolkitArchive(archive.path);
  const entry = entries.get(resource.path);
  if (!entry || entry.type === "5") throw new Error(`Toolkit resource 不存在：${resource.path}`);
  const output = join(materializationRoot(), resource.sha256, resource.id);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (existsSync(output)) {
    materialized.set(key, output);
    return output;
  }
  const source = openSync(archive.path, "r");
  const target = openSync(output, "wx", executable ? 0o700 : 0o600);
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  const hash = createHash("sha256");
  let copied = 0;
  try {
    while (copied < entry.size) {
      const length = Math.min(buffer.length, entry.size - copied);
      const count = readSync(source, buffer, 0, length, entry.dataOffset + copied);
      if (count <= 0) throw new Error(`Toolkit resource 读取不完整：${resource.path}`);
      const chunk = buffer.subarray(0, count);
      writeSync(target, chunk);
      hash.update(chunk);
      copied += count;
    }
  } finally {
    closeSync(source);
    closeSync(target);
  }
  const actual = hash.digest("hex");
  if (actual !== resource.sha256) {
    rmSync(output, { force: true });
    throw new Error(`Toolkit resource SHA-256 不匹配：${resource.path}`);
  }
  if (executable) chmodSync(output, 0o700);
  materialized.set(key, output);
  return output;
}

process.once("exit", () => {
  if (materializedRoot) rmSync(materializedRoot, { recursive: true, force: true });
});
