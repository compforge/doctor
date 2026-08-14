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
  ToolkitBundle,
  ToolkitBundleComponent,
  ToolkitBundleCompatibility,
  ToolkitManifest,
  ToolkitOs,
  ToolkitPlatformManifest,
  ToolkitResource,
  ToolkitResourceKind,
} from "./model";
import type {
  TargetCpuRequirement,
  TargetLibraryRequirement,
  TargetRequirements,
  TargetVersionRange,
} from "../target/requirements";

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

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} 包含未知字段：${unknown.join(", ")}`);
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

function parseVersionRange(value: unknown, label: string): TargetVersionRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} version range 无效`);
  }
  const range = value as Record<string, unknown>;
  rejectUnknownKeys(range, ["minInclusive", "maxExclusive"], label);
  for (const field of ["minInclusive", "maxExclusive"] as const) {
    if (range[field] !== undefined && (typeof range[field] !== "string" || !range[field])) {
      throw new Error(`${label}.${field} 无效`);
    }
  }
  return {
    minInclusive: range.minInclusive as string | undefined,
    maxExclusive: range.maxExclusive as string | undefined,
  };
}

function parseStringList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`${label} 无效`);
  }
  return value as string[];
}

function parseRequirements(value: unknown, label: string): TargetRequirements {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} requirements 无效`);
  }
  const requirements = value as Record<string, unknown>;
  rejectUnknownKeys(requirements, ["software", "hardware"], `${label} requirements`);
  let software: TargetRequirements["software"];
  if (requirements.software !== undefined) {
    if (!requirements.software || typeof requirements.software !== "object"
      || Array.isArray(requirements.software)) {
      throw new Error(`${label} requirements.software 无效`);
    }
    const raw = requirements.software as Record<string, unknown>;
    rejectUnknownKeys(raw, ["os", "kernel", "libraries"], `${label} requirements.software`);
    let os: NonNullable<TargetRequirements["software"]>["os"];
    if (raw.os !== undefined) {
      if (!raw.os || typeof raw.os !== "object" || Array.isArray(raw.os)) {
        throw new Error(`${label} requirements.software.os 无效`);
      }
      const value = raw.os as Record<string, unknown>;
      rejectUnknownKeys(value, ["ids", "version"], `${label} requirements.software.os`);
      os = {
        ids: parseStringList(value.ids, `${label} os.ids`),
        version: value.version === undefined
          ? undefined
          : parseVersionRange(value.version, `${label} os`),
      };
    }
    let libraries: TargetLibraryRequirement[] | undefined;
    if (raw.libraries !== undefined) {
      if (!Array.isArray(raw.libraries)) {
        throw new Error(`${label} requirements.software.libraries 无效`);
      }
      libraries = raw.libraries.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error(`${label} library requirement 无效`);
        }
        const library = item as Record<string, unknown>;
        rejectUnknownKeys(library, ["name", "family", "version"], `${label} library`);
        if (typeof library.name !== "string" || !/^[a-z][a-z0-9._+-]*$/.test(library.name)) {
          throw new Error(`${label} library name 无效`);
        }
        if (library.family !== undefined
          && (typeof library.family !== "string" || !library.family.trim())) {
          throw new Error(`${label} library family 无效`);
        }
        return {
          name: library.name,
          family: library.family as string | undefined,
          version: library.version === undefined
            ? undefined
            : parseVersionRange(library.version, `${label} library ${library.name}`),
        };
      });
      if (new Set(libraries.map((library) => library.name)).size !== libraries.length) {
        throw new Error(`${label} library requirement 重复`);
      }
    }
    software = {
      os,
      kernel: raw.kernel === undefined
        ? undefined
        : parseVersionRange(raw.kernel, `${label} kernel`),
      libraries,
    };
  }
  let hardware: TargetRequirements["hardware"];
  if (requirements.hardware !== undefined) {
    if (!requirements.hardware || typeof requirements.hardware !== "object"
      || Array.isArray(requirements.hardware)) {
      throw new Error(`${label} requirements.hardware 无效`);
    }
    const raw = requirements.hardware as Record<string, unknown>;
    rejectUnknownKeys(raw, ["cpu"], `${label} requirements.hardware`);
    let cpu: TargetCpuRequirement | undefined;
    if (raw.cpu !== undefined) {
      if (!raw.cpu || typeof raw.cpu !== "object" || Array.isArray(raw.cpu)) {
        throw new Error(`${label} requirements.hardware.cpu 无效`);
      }
      const value = raw.cpu as Record<string, unknown>;
      rejectUnknownKeys(
        value,
        ["vendors", "families", "models", "features"],
        `${label} requirements.hardware.cpu`,
      );
      cpu = {
        vendors: parseStringList(value.vendors, `${label} cpu.vendors`),
        families: parseStringList(value.families, `${label} cpu.families`),
        models: parseStringList(value.models, `${label} cpu.models`),
        features: parseStringList(value.features, `${label} cpu.features`),
      };
    }
    hardware = { cpu };
  }
  return { software, hardware };
}

function parseResource(value: unknown, platform: string, requirementsRequired: boolean): ToolkitResource {
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
  if (requirementsRequired && (typeof resource.version !== "string" || !resource.version.trim())) {
    throw new Error(`Toolkit ${platform} resource ${resource.id} 缺少 version`);
  }
  if (requirementsRequired && resource.requirements === undefined) {
    throw new Error(`Toolkit ${platform} resource ${resource.id} 缺少 requirements`);
  }
  if (resource.version !== undefined && (typeof resource.version !== "string" || !resource.version.trim())) {
    throw new Error(`Toolkit ${platform} resource ${resource.id} version 无效`);
  }
  return {
    id: resource.id,
    version: resource.version as string | undefined,
    requirements: resource.requirements === undefined
      ? undefined
      : parseRequirements(resource.requirements, `Toolkit resource ${resource.id}`),
    path: resource.path,
    sha256: resource.sha256,
    size: resource.size,
  } as ToolkitResource;
}

function parseCompatibility(value: unknown, bundle: string): ToolkitBundleCompatibility | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Toolkit bundle ${bundle} compatibility 无效`);
  }
  const compatibility = value as Record<string, unknown>;
  let runtime: ToolkitBundleCompatibility["runtime"];
  if (compatibility.runtime !== undefined) {
    if (
      !compatibility.runtime
      || typeof compatibility.runtime !== "object"
      || Array.isArray(compatibility.runtime)
    ) throw new Error(`Toolkit bundle ${bundle} runtime compatibility 无效`);
    const raw = compatibility.runtime as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name || typeof raw.version !== "string" || !raw.version) {
      throw new Error(`Toolkit bundle ${bundle} runtime compatibility 无效`);
    }
    runtime = { name: raw.name, version: raw.version };
  }
  let libc: ToolkitBundleCompatibility["libc"];
  if (compatibility.libc !== undefined) {
    if (
      !compatibility.libc
      || typeof compatibility.libc !== "object"
      || Array.isArray(compatibility.libc)
    ) throw new Error(`Toolkit bundle ${bundle} libc compatibility 无效`);
    const raw = compatibility.libc as Record<string, unknown>;
    if (
      typeof raw.family !== "string"
      || !raw.family
      || typeof raw.minimumVersion !== "string"
      || !/^\d+(?:\.\d+)+$/.test(raw.minimumVersion)
    ) throw new Error(`Toolkit bundle ${bundle} libc compatibility 无效`);
    libc = { family: raw.family, minimumVersion: raw.minimumVersion };
  }
  return { runtime, libc };
}

function parseBundleComponent(
  value: unknown,
  bundle: string,
  resourceVersionRequired: boolean,
): ToolkitBundleComponent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Toolkit bundle ${bundle} component 无效`);
  }
  const component = value as Record<string, unknown>;
  if (typeof component.role !== "string" || !/^[a-z][a-z0-9-]*$/.test(component.role)) {
    throw new Error(`Toolkit bundle ${bundle} component role 无效`);
  }
  if (!(component.kind === "tool" || component.kind === "image" || component.kind === "package")) {
    throw new Error(`Toolkit bundle ${bundle} component kind 无效`);
  }
  if (
    typeof component.resourceId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(component.resourceId)
  ) throw new Error(`Toolkit bundle ${bundle} component resourceId 无效`);
  if (resourceVersionRequired
    && (typeof component.resourceVersion !== "string" || !component.resourceVersion.trim())) {
    throw new Error(`Toolkit bundle ${bundle} component 缺少 resourceVersion`);
  }
  if (component.resourceVersion !== undefined
    && (typeof component.resourceVersion !== "string" || !component.resourceVersion.trim())) {
    throw new Error(`Toolkit bundle ${bundle} component resourceVersion 无效`);
  }
  return {
    role: component.role,
    kind: component.kind as ToolkitResourceKind,
    resourceId: component.resourceId,
    resourceVersion: component.resourceVersion as string | undefined,
  };
}

function parseBundle(
  value: unknown,
  platform: string,
  resourceVersionRequired: boolean,
): ToolkitBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Toolkit ${platform} bundle 无效`);
  }
  const bundle = value as Record<string, unknown>;
  if (typeof bundle.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(bundle.id)) {
    throw new Error(`Toolkit ${platform} bundle id 无效`);
  }
  if (typeof bundle.protocol !== "string" || !/^[A-Za-z0-9._+-]+\/v\d+$/.test(bundle.protocol)) {
    throw new Error(`Toolkit bundle ${String(bundle.id)} protocol 无效`);
  }
  if (typeof bundle.version !== "string" || !bundle.version.trim()) {
    throw new Error(`Toolkit bundle ${String(bundle.id)} version 无效`);
  }
  if (!Array.isArray(bundle.components) || bundle.components.length === 0) {
    throw new Error(`Toolkit bundle ${bundle.id} components 无效`);
  }
  const components = bundle.components.map((item) => parseBundleComponent(
    item,
    bundle.id as string,
    resourceVersionRequired,
  ));
  if (new Set(components.map((item) => item.role)).size !== components.length) {
    throw new Error(`Toolkit bundle ${bundle.id} component role 重复`);
  }
  return {
    id: bundle.id,
    protocol: bundle.protocol,
    version: bundle.version,
    compatibility: parseCompatibility(bundle.compatibility, bundle.id),
    components,
  };
}

function parsePlatform(
  value: unknown,
  bundlesRequired: boolean,
  requirementsRequired: boolean,
): ToolkitPlatformManifest {
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
    const resources = raw.map((item) => parseResource(item, platformId, requirementsRequired));
    const keys = resources.map((item) => requirementsRequired
      ? JSON.stringify([item.id, item.version, item.requirements])
      : item.id);
    if (new Set(keys).size !== resources.length) {
      throw new Error(`Toolkit ${platformId}.${field} id 重复`);
    }
    return resources;
  };
  const tools = parseResources("tools");
  const images = parseResources("images");
  const packages = parseResources("packages");
  if (bundlesRequired && !Array.isArray(platform.bundles)) {
    throw new Error(`Toolkit ${platformId}.bundles 无效`);
  }
  const bundles = Array.isArray(platform.bundles)
    ? platform.bundles.map((item) => parseBundle(item, platformId, requirementsRequired))
    : [];
  const resourcesByKind: Record<ToolkitResourceKind, readonly ToolkitResource[]> = {
    tool: tools,
    image: images,
    package: packages,
  };
  for (const bundle of bundles) {
    for (const component of bundle.components) {
      if (!resourcesByKind[component.kind].some((item) => (
        item.id === component.resourceId
        && (component.resourceVersion === undefined || item.version === component.resourceVersion)
      ))) {
        throw new Error(
          `Toolkit bundle ${bundle.id} 引用了不存在的 ${component.kind} ${component.resourceId}`,
        );
      }
    }
  }
  const bundleKeys = bundles.map((bundle) => JSON.stringify([
    bundle.id,
    bundle.protocol,
    bundle.version,
    bundle.compatibility ?? null,
  ]));
  if (new Set(bundleKeys).size !== bundleKeys.length) {
    throw new Error(`Toolkit ${platformId} bundle compatibility 重复`);
  }
  return {
    os,
    architecture,
    tools,
    images,
    packages,
    bundles,
  };
}

export function parseToolkitManifest(raw: string): ToolkitManifest {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.schema !== "doctor.toolkit/v1"
    && value.schema !== "doctor.toolkit/v2"
    && value.schema !== "doctor.toolkit/v3") {
    throw new Error(`不支持的 Toolkit schema：${String(value.schema)}`);
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("Toolkit manifest 缺少 version");
  }
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    throw new Error("Toolkit manifest platforms 无效");
  }
  const schema = value.schema;
  const platforms = value.platforms.map((platform) => parsePlatform(
    platform,
    schema !== "doctor.toolkit/v1",
    schema === "doctor.toolkit/v3",
  ));
  const ids = platforms.map((item) => `${item.os}/${item.architecture}`);
  if (new Set(ids).size !== ids.length) throw new Error("Toolkit platform 重复");
  return { schema, version: value.version, platforms };
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
