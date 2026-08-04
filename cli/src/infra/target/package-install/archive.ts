import {
  closeSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  PackageBundle,
  PackageBundleManifest,
  PackageManagerKind,
  PackageTargetFact,
} from "./model";

const TAR_BLOCK_SIZE = 512;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const BUNDLE_SCHEMA = "doctor-packages/v1";
const MANIFEST_PATH = "doctor-packages/manifest.json";
const PACKAGE_MANAGERS = new Set<PackageManagerKind>([
  "apk",
  "apt-get",
  "dnf",
  "microdnf",
  "yum",
]);

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

function readBundleManifest(path: string): string {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  let offset = 0;
  let hasAptIndex = false;
  let hasDeb = false;
  let manifest: string | undefined;
  try {
    while (readSync(fd, header, 0, TAR_BLOCK_SIZE, offset) === TAR_BLOCK_SIZE) {
      if (header.every((value) => value === 0)) break;
      const name = tarString(header, 0, 100);
      const prefix = tarString(header, 345, 155);
      const fullName = prefix ? `${prefix}/${name}` : name;
      if (!safeEntryName(fullName) || !fullName.startsWith("doctor-packages/")) {
        throw new Error(`bundle 包含不安全或越界条目：${fullName}`);
      }
      const entryType = header[156] === 0 ? "" : String.fromCharCode(header[156]!);
      if (!["", "0", "5"].includes(entryType)) {
        throw new Error(`bundle 不允许 link 或特殊条目：${fullName}`);
      }
      const sizeText = tarString(header, 124, 12).replace(/^0+/, "") || "0";
      const size = Number.parseInt(sizeText, 8);
      if (!Number.isFinite(size) || size < 0) {
        throw new Error(`bundle 条目大小无效：${fullName}`);
      }
      const dataOffset = offset + TAR_BLOCK_SIZE;
      if (fullName === MANIFEST_PATH) {
        if (size > MAX_MANIFEST_BYTES) throw new Error("bundle manifest 过大");
        const data = Buffer.alloc(size);
        if (readSync(fd, data, 0, size, dataOffset) !== size) {
          throw new Error("bundle manifest 读取不完整");
        }
        manifest = data.toString("utf8");
      }
      if (/^doctor-packages\/repo\/Packages(?:\.gz)?$/.test(fullName)) hasAptIndex = true;
      if (/^doctor-packages\/repo\/.+\.deb$/.test(fullName)) hasDeb = true;
      offset = dataOffset + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }
  } finally {
    closeSync(fd);
  }
  if (!manifest) throw new Error(`缺少 ${MANIFEST_PATH}`);
  if (!hasAptIndex || !hasDeb) {
    throw new Error("缺少 doctor-packages/repo/Packages(.gz) 或 .deb 文件");
  }
  return manifest;
}

export function parsePackageBundleManifest(raw: string): PackageBundleManifest {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.schema !== BUNDLE_SCHEMA) {
    throw new Error(`不支持的 bundle schema：${String(parsed.schema)}`);
  }
  if (!PACKAGE_MANAGERS.has(parsed.packageManager as PackageManagerKind)) {
    throw new Error(`不支持的 packageManager：${String(parsed.packageManager)}`);
  }
  for (const field of ["bundleVersion", "osId", "osVersionId", "architecture"] as const) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new Error(`bundle manifest 缺少 ${field}`);
    }
  }
  if (
    !Array.isArray(parsed.packages)
    || !parsed.packages.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new Error("bundle manifest packages 无效");
  }
  if (
    parsed.packageVersions !== undefined
    && (
      typeof parsed.packageVersions !== "object"
      || parsed.packageVersions === null
      || Array.isArray(parsed.packageVersions)
      || !Object.entries(parsed.packageVersions).every(
        ([name, version]) => name.trim() && typeof version === "string" && version.trim(),
      )
    )
  ) {
    throw new Error("bundle manifest packageVersions 无效");
  }
  const compatibility = parsed.compatibility as Record<string, unknown> | undefined;
  if (
    compatibility !== undefined
    && (typeof compatibility !== "object" || compatibility === null || Array.isArray(compatibility))
  ) {
    throw new Error("bundle manifest compatibility 无效");
  }
  const kernel = compatibility?.kernel as Record<string, unknown> | undefined;
  if (
    kernel !== undefined
    && (
      typeof kernel !== "object"
      || kernel === null
      || Array.isArray(kernel)
      || !["minInclusive", "maxExclusive"].every(
        (field) => kernel[field] === undefined
          || (typeof kernel[field] === "string" && Boolean(kernel[field].trim())),
      )
    )
  ) {
    throw new Error("bundle manifest compatibility.kernel 无效");
  }
  return parsed as unknown as PackageBundleManifest;
}

export function inspectPackageBundle(path: string): PackageBundle {
  const absolute = resolve(path);
  if (!statSync(absolute).isFile()) throw new Error(`不是文件：${path}`);
  try {
    return { path: absolute, manifest: parsePackageBundleManifest(readBundleManifest(absolute)) };
  } catch (error) {
    throw new Error(
      `无法读取 package bundle ${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function versionMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  return expected === actual || expected.split(".")[0] === actual.split(".")[0];
}

function compareLinuxVersions(left: string, right: string): number {
  const parse = (value: string) => value
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function kernelMatches(bundle: PackageBundle, target: PackageTargetFact): boolean {
  const range = bundle.manifest.compatibility?.kernel;
  if (!range) return true;
  if (!target.kernelVersion) return false;
  if (
    range.minInclusive
    && compareLinuxVersions(target.kernelVersion, range.minInclusive) < 0
  ) return false;
  if (
    range.maxExclusive
    && compareLinuxVersions(target.kernelVersion, range.maxExclusive) >= 0
  ) return false;
  return true;
}

export function bundleMatches(
  bundle: PackageBundle,
  target: PackageTargetFact,
  packages: readonly string[],
): boolean {
  const manifest = bundle.manifest;
  return manifest.packageManager === target.manager.kind
    && manifest.osId === target.osId
    && versionMatches(manifest.osVersionId, target.osVersionId)
    && manifest.architecture === target.architecture
    && packages.every((name) => manifest.packages.includes(name))
    && kernelMatches(bundle, target);
}

function comparePackageVersions(left: string | undefined, right: string | undefined): number {
  // Debian epochs outrank the upstream version, so 1:17.2 is newer than 13.1.
  const parse = (value: string | undefined): [number, string] => {
    const normalized = value ?? "";
    const match = /^(\d+):(.*)$/.exec(normalized);
    return match ? [Number.parseInt(match[1]!, 10), match[2]!] : [0, normalized];
  };
  const [leftEpoch, leftVersion] = parse(left);
  const [rightEpoch, rightVersion] = parse(right);
  if (leftEpoch !== rightEpoch) return leftEpoch < rightEpoch ? -1 : 1;
  return leftVersion.localeCompare(rightVersion, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function selectPackageBundle(
  bundles: readonly PackageBundle[],
  target: PackageTargetFact,
  packages: readonly string[],
): PackageBundle | undefined {
  // Platform/kernel compatibility is a hard gate; versions only rank surviving candidates.
  return bundles
    .filter((bundle) => bundleMatches(bundle, target, packages))
    .sort((left, right) => {
      const leftKernelSpecific = left.manifest.compatibility?.kernel ? 1 : 0;
      const rightKernelSpecific = right.manifest.compatibility?.kernel ? 1 : 0;
      if (leftKernelSpecific !== rightKernelSpecific) {
        return rightKernelSpecific - leftKernelSpecific;
      }
      for (const name of packages) {
        const difference = comparePackageVersions(
          right.manifest.packageVersions?.[name],
          left.manifest.packageVersions?.[name],
        );
        if (difference !== 0) return difference;
      }
      return comparePackageVersions(
        right.manifest.bundleVersion,
        left.manifest.bundleVersion,
      );
    })[0];
}
