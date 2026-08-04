import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { inspectPackageBundle, parsePackageBundleManifest } from "./archive";
import type {
  MaterializedPackageBundle,
  PackageBundle,
  PackageBundleManifest,
} from "./model";

const TAR_BLOCK_SIZE = 512;
const COPY_BUFFER_SIZE = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_VARIANT_BYTES = 256 * 1024 * 1024;
const SET_SCHEMA = "doctor-package-set/v1";
const SET_ROOT = "doctor-package-set/";
const SET_MANIFEST_PATH = `${SET_ROOT}manifest.json`;

interface TarEntry {
  name: string;
  dataOffset: number;
  size: number;
  type: string;
}

interface PackageSetVariant {
  id: string;
  path: string;
  sha256: string;
  manifest: PackageBundleManifest;
}

interface PackageSetManifest {
  schema: typeof SET_SCHEMA;
  bundleVersion: string;
  variants: PackageSetVariant[];
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

function scanPackageSet(path: string): Map<string, TarEntry> {
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
      if (!safeEntryName(fullName) || !fullName.startsWith(SET_ROOT)) {
        throw new Error(`package set 包含不安全或越界条目：${fullName}`);
      }
      const type = header[156] === 0 ? "" : String.fromCharCode(header[156]!);
      if (!["", "0", "5"].includes(type)) {
        throw new Error(`package set 不允许 link 或特殊条目：${fullName}`);
      }
      const sizeText = tarString(header, 124, 12).replace(/^0+/, "") || "0";
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error(`package set 条目大小无效：${fullName}`);
      }
      if (entries.has(fullName)) throw new Error(`package set 包含重复条目：${fullName}`);
      const dataOffset = offset + TAR_BLOCK_SIZE;
      entries.set(fullName, { name: fullName, dataOffset, size, type });
      offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }
  } finally {
    closeSync(fd);
  }
  return entries;
}

function readEntry(path: string, entry: TarEntry, maxBytes: number): string {
  if (entry.type === "5") throw new Error(`package set 条目不是文件：${entry.name}`);
  if (entry.size > maxBytes) throw new Error(`package set 条目过大：${entry.name}`);
  const fd = openSync(path, "r");
  const data = Buffer.alloc(entry.size);
  try {
    if (readSync(fd, data, 0, entry.size, entry.dataOffset) !== entry.size) {
      throw new Error(`package set 条目读取不完整：${entry.name}`);
    }
  } finally {
    closeSync(fd);
  }
  return data.toString("utf8");
}

function parsePackageSetManifest(raw: string): PackageSetManifest {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.schema !== SET_SCHEMA) {
    throw new Error(`不支持的 package set schema：${String(parsed.schema)}`);
  }
  if (typeof parsed.bundleVersion !== "string" || !parsed.bundleVersion.trim()) {
    throw new Error("package set manifest 缺少 bundleVersion");
  }
  if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
    throw new Error("package set manifest variants 无效");
  }
  const variants = parsed.variants.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("package set variant 无效");
    }
    const variant = value as Record<string, unknown>;
    if (
      typeof variant.id !== "string"
      || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(variant.id)
    ) {
      throw new Error("package set variant id 无效");
    }
    if (
      typeof variant.path !== "string"
      || !/^doctor-package-set\/variants\/[0-9A-Za-z][0-9A-Za-z._+-]*\.tar$/.test(variant.path)
    ) {
      throw new Error(`package set variant path 无效：${String(variant.path)}`);
    }
    if (typeof variant.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(variant.sha256)) {
      throw new Error(`package set variant sha256 无效：${variant.id}`);
    }
    return {
      id: variant.id,
      path: variant.path,
      sha256: variant.sha256,
      manifest: parsePackageBundleManifest(JSON.stringify(variant.manifest)),
    };
  });
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) {
    throw new Error("package set variant id 重复");
  }
  if (new Set(variants.map((variant) => variant.path)).size !== variants.length) {
    throw new Error("package set variant path 重复");
  }
  return {
    schema: SET_SCHEMA,
    bundleVersion: parsed.bundleVersion,
    variants,
  };
}

export function inspectPackageBundleSet(path: string): PackageBundle[] {
  const absolute = resolve(path);
  if (!statSync(absolute).isFile()) throw new Error(`不是文件：${path}`);
  try {
    const entries = scanPackageSet(absolute);
    const manifestEntry = entries.get(SET_MANIFEST_PATH);
    if (!manifestEntry) throw new Error(`缺少 ${SET_MANIFEST_PATH}`);
    const manifest = parsePackageSetManifest(
      readEntry(absolute, manifestEntry, MAX_MANIFEST_BYTES),
    );
    const expectedFiles = new Set([SET_MANIFEST_PATH]);
    for (const variant of manifest.variants) {
      expectedFiles.add(variant.path);
      const entry = entries.get(variant.path);
      if (!entry || entry.type === "5") {
        throw new Error(`缺少 package set variant：${variant.path}`);
      }
      if (entry.size > MAX_VARIANT_BYTES) {
        throw new Error(`package set variant 过大：${variant.path}`);
      }
    }
    for (const entry of entries.values()) {
      if (entry.type !== "5" && !expectedFiles.has(entry.name)) {
        throw new Error(`package set 包含未声明文件：${entry.name}`);
      }
    }
    return manifest.variants.map((variant) => ({
      path: absolute,
      manifest: variant.manifest,
      variant: {
        id: variant.id,
        entryPath: variant.path,
        sha256: variant.sha256,
        setVersion: manifest.bundleVersion,
      },
    }));
  } catch (error) {
    throw new Error(
      `无法读取 package set ${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function copyVariant(
  archivePath: string,
  entry: TarEntry,
  outputPath: string,
  expectedSha256: string,
): void {
  const source = openSync(archivePath, "r");
  const output = openSync(outputPath, "wx");
  const buffer = Buffer.alloc(COPY_BUFFER_SIZE);
  const hash = createHash("sha256");
  let copied = 0;
  try {
    while (copied < entry.size) {
      const length = Math.min(buffer.length, entry.size - copied);
      const count = readSync(source, buffer, 0, length, entry.dataOffset + copied);
      if (count <= 0) throw new Error(`package set variant 读取不完整：${entry.name}`);
      const chunk = buffer.subarray(0, count);
      writeSync(output, chunk);
      hash.update(chunk);
      copied += count;
    }
  } finally {
    closeSync(source);
    closeSync(output);
  }
  if (hash.digest("hex") !== expectedSha256) {
    throw new Error(`package set variant SHA-256 不匹配：${entry.name}`);
  }
}

export function materializePackageBundle(bundle: PackageBundle): MaterializedPackageBundle {
  if (!bundle.variant) return { path: bundle.path, cleanup: () => undefined };
  const entries = scanPackageSet(bundle.path);
  const entry = entries.get(bundle.variant.entryPath);
  if (!entry || entry.type === "5") {
    throw new Error(`package set variant 不存在：${bundle.variant.entryPath}`);
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "doctor-package-variant-"));
  const outputPath = join(temporaryRoot, basename(bundle.variant.entryPath));
  try {
    copyVariant(bundle.path, entry, outputPath, bundle.variant.sha256);
    const materialized = inspectPackageBundle(outputPath);
    if (canonicalJson(materialized.manifest) !== canonicalJson(bundle.manifest)) {
      throw new Error(`package set variant manifest 不匹配：${bundle.variant.id}`);
    }
    return {
      path: outputPath,
      cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
