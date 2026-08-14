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
import {
  targetRequirementsMatch,
  type TargetRequirements,
} from "../requirements";

const TAR_BLOCK_SIZE = 512;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const BUNDLE_SCHEMAS = new Set(["doctor-packages/v1", "doctor-packages/v2"]);
const MANIFEST_PATH = "doctor-packages/manifest.json";
const PACKAGE_MANAGERS = new Set<PackageManagerKind>([
  "apk",
  "apt-get",
  "dnf",
  "microdnf",
  "yum",
]);

function validateKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} 包含未知字段：${unknown.join(", ")}`);
}

function validateRange(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 无效`);
  }
  const range = value as Record<string, unknown>;
  validateKeys(range, ["minInclusive", "maxExclusive"], label);
  const valid = ["minInclusive", "maxExclusive"].every((field) => {
    const item = range[field];
    return item === undefined || (typeof item === "string" && Boolean(item));
  });
  if (!valid) {
    throw new Error(`${label} 无效`);
  }
}

function validateRequirements(value: Record<string, unknown>): void {
  validateKeys(value, ["software", "hardware"], "bundle manifest requirements");
  const software = value.software as Record<string, unknown> | undefined;
  const hardware = value.hardware as Record<string, unknown> | undefined;
  if (software !== undefined) {
    if (!software || typeof software !== "object" || Array.isArray(software)) {
      throw new Error("bundle manifest requirements.software 无效");
    }
    validateKeys(software, ["os", "kernel", "libraries"], "bundle manifest requirements.software");
    if (software.os !== undefined) {
      if (!software.os || typeof software.os !== "object" || Array.isArray(software.os)) {
        throw new Error("bundle manifest requirements.software.os 无效");
      }
      const os = software.os as Record<string, unknown>;
      validateKeys(os, ["ids", "version"], "bundle manifest requirements.software.os");
      if (os.version !== undefined) validateRange(os.version, "bundle manifest OS version");
      if (os.ids !== undefined && (!Array.isArray(os.ids)
        || !os.ids.every((item) => typeof item === "string" && item.trim()))) {
        throw new Error("bundle manifest requirements.software.os.ids 无效");
      }
    }
    if (software.kernel !== undefined) validateRange(software.kernel, "bundle manifest kernel");
    if (software.libraries !== undefined && (!Array.isArray(software.libraries)
      || !software.libraries.every((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const library = item as Record<string, unknown>;
        validateKeys(library, ["name", "family", "version"], "bundle manifest library");
        if (library.version !== undefined) validateRange(library.version, "bundle manifest library version");
        return typeof library.name === "string" && Boolean(library.name.trim())
          && (library.family === undefined
            || (typeof library.family === "string" && Boolean(library.family.trim())));
      }))) {
      throw new Error("bundle manifest requirements.software.libraries 无效");
    }
  }
  if (hardware !== undefined) {
    if (!hardware || typeof hardware !== "object" || Array.isArray(hardware)) {
      throw new Error("bundle manifest requirements.hardware 无效");
    }
    validateKeys(hardware, ["cpu"], "bundle manifest requirements.hardware");
    if (hardware.cpu !== undefined) {
      if (!hardware.cpu || typeof hardware.cpu !== "object" || Array.isArray(hardware.cpu)) {
        throw new Error("bundle manifest requirements.hardware.cpu 无效");
      }
      const cpu = hardware.cpu as Record<string, unknown>;
      validateKeys(cpu, ["vendors", "families", "models", "features"], "bundle manifest cpu");
      const valid = ["vendors", "families", "models", "features"].every((field) => {
        const items = cpu[field];
        return items === undefined || (Array.isArray(items)
          && items.every((item) => typeof item === "string" && Boolean(item.trim())));
      });
      if (!valid) {
        throw new Error("bundle manifest requirements.hardware.cpu 无效");
      }
    }
  }
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
  if (!BUNDLE_SCHEMAS.has(parsed.schema as string)) {
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
  if (parsed.schema === "doctor-packages/v2") {
    if (!parsed.requirements || typeof parsed.requirements !== "object"
      || Array.isArray(parsed.requirements)) {
      throw new Error("bundle manifest 缺少 requirements");
    }
    validateRequirements(parsed.requirements as Record<string, unknown>);
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

export function packageBundleRequirements(bundle: PackageBundle): TargetRequirements | undefined {
  if (bundle.manifest.requirements) return bundle.manifest.requirements;
  const kernel = bundle.manifest.compatibility?.kernel;
  return kernel ? { software: { kernel } } : undefined;
}

export function bundleMatches(
  bundle: PackageBundle,
  target: PackageTargetFact,
  packages: readonly string[],
): boolean {
  return bundlePlatformMatches(bundle, target, packages)
    && targetRequirementsMatch(packageBundleRequirements(bundle), {
      ...target,
      cpu: target.cpu ? { ...target.cpu, features: target.cpu.flags } : undefined,
    });
}

export function bundlePlatformMatches(
  bundle: PackageBundle,
  target: PackageTargetFact,
  packages: readonly string[],
): boolean {
  const manifest = bundle.manifest;
  return manifest.packageManager === target.manager.kind
    && manifest.osId === target.osId
    && versionMatches(manifest.osVersionId, target.osVersionId)
    && manifest.architecture === target.architecture
    && packages.every((name) => manifest.packages.includes(name));
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
  return matchingPackageBundles(bundles, target, packages)[0];
}

export function matchingPackageBundles(
  bundles: readonly PackageBundle[],
  target: PackageTargetFact,
  packages: readonly string[],
): PackageBundle[] {
  return bundles
    .filter((bundle) => bundleMatches(bundle, target, packages))
    .sort((left, right) => {
      const leftSpecific = packageBundleRequirements(left) ? 1 : 0;
      const rightSpecific = packageBundleRequirements(right) ? 1 : 0;
      if (leftSpecific !== rightSpecific) {
        return rightSpecific - leftSpecific;
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
    });
}
