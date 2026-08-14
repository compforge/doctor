import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

interface ReleaseAsset {
  browser_download_url: string;
  digest?: string;
  name: string;
  size: number;
}

interface Release {
  assets: ReleaseAsset[];
  draft: boolean;
  tag_name: string;
}

interface ToolkitResource {
  path: string;
  sha256: string;
  size: number;
}

interface PackageVariant {
  id: string;
  path: string;
  sha256: string;
  manifest: {
    architecture: string;
    bundleVersion: string;
    osId: string;
    osVersionId: string;
    packageVersions: Record<string, string>;
  };
}

interface VariantInput {
  gdbSourceSha256: string;
  gdbVersion: string;
  id: string;
  packageVersion: string;
}

interface BuildGroup {
  schema: "doctor.toolkit.build-group/v1";
  kind: "packages";
  platform: { os: "linux"; architecture: string };
  key: string;
  inputs: {
    compatibility: {
      glibcMinInclusive: string;
      kernelMaxExclusive: string;
      kernelMinInclusive: string;
    };
    distribution: { id: "debian"; version: "12" };
    recipe: Array<{ path: string; sha256: string }>;
    variants: VariantInput[];
  };
}

const [currentVersion, architecture, outputArg, ...expectedArgs] = process.argv.slice(2);
if (!currentVersion || !architecture || !outputArg || expectedArgs.length === 0) {
  throw new Error(
    "usage: reuse-package-set.ts <version> <amd64|arm64> <output.tar> "
      + "<id|gdb-version|source-sha256|package-version>...",
  );
}

const toolkitRoot = resolve(import.meta.dir, "..");
const repository = process.env.DOCTOR_TOOLKIT_RELEASE_REPOSITORY || "compforge/doctor";
const cacheRoot = process.env.DOCTOR_TOOLKIT_CACHE_DIR
  || join(homedir(), ".cache", "doctor-toolkit", "releases");
const variantInputs = expectedArgs.map((argument): VariantInput => {
  const [id, gdbVersion, gdbSourceSha256, packageVersion, ...extra] = argument.split("|");
  if (
    extra.length > 0
    || !id
    || !gdbVersion
    || !gdbSourceSha256
    || !/^[0-9a-f]{64}$/.test(gdbSourceSha256)
    || !packageVersion
  ) throw new Error(`invalid expected package variant: ${argument}`);
  return { id, gdbVersion, gdbSourceSha256, packageVersion };
});
const expectedVersions = new Map(variantInputs.map((variant) => [
  variant.id,
  variant.packageVersion,
]));
const packageRecipePaths = [
  "toolkit/packages/debian/Dockerfile",
  "toolkit/packages/debian/build-bundle.sh",
  "toolkit/scripts/build-package-bundle.sh",
];

function command(command: string, args: string[], options: { cwd?: string } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${result.stderr?.trim() || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout || "";
}

function extractEntry(archive: string, entry: string, output: string): void {
  if (!entry || entry.startsWith("/") || entry.split("/").includes("..")) {
    throw new Error(`unsafe archive entry: ${entry}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  const fd = openSync(output, "w");
  try {
    const result = spawnSync("tar", ["-xOf", archive, entry], {
      stdio: ["ignore", fd, "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`unable to extract ${entry}: ${result.stderr.trim()}`);
  } finally {
    closeSync(fd);
  }
}

function readJsonEntry(archive: string, entry: string): Record<string, unknown> {
  return JSON.parse(command("tar", ["-xOf", archive, entry])) as Record<string, unknown>;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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

async function currentBuildGroup(): Promise<BuildGroup> {
  const repositoryRoot = command("git", ["rev-parse", "--show-toplevel"], {
    cwd: toolkitRoot,
  }).trim();
  const inputs: BuildGroup["inputs"] = {
    compatibility: {
      glibcMinInclusive: "2.36",
      kernelMaxExclusive: process.env.DOCTOR_KERNEL_MAX_EXCLUSIVE || "",
      kernelMinInclusive: process.env.DOCTOR_KERNEL_MIN_INCLUSIVE || "",
    },
    distribution: { id: "debian", version: "12" },
    recipe: await Promise.all(packageRecipePaths.map(async (path) => ({
      path,
      sha256: await sha256(join(repositoryRoot, path)),
    }))),
    variants: variantInputs,
  };
  // Toolkit version is packaging metadata, not an expensive package-build input. Excluding it lets
  // a verified payload be re-wrapped for a later Toolkit release without recompiling GDB.
  const key = createHash("sha256").update(canonicalJson({
    kind: "packages",
    platform: { os: "linux", architecture },
    inputs,
  })).digest("hex");
  return {
    schema: "doctor.toolkit.build-group/v1",
    kind: "packages",
    platform: { os: "linux", architecture },
    key: `sha256:${key}`,
    inputs,
  };
}

function writeBuildGroup(group: BuildGroup): void {
  const directory = process.env.DOCTOR_TOOLKIT_BUILD_INPUTS_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `linux-${architecture}-packages.json`),
    `${JSON.stringify(group, null, 2)}\n`,
  );
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(?:toolkit-v)?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match
    ? [Number.parseInt(match[1]!), Number.parseInt(match[2]!), Number.parseInt(match[3]!)]
    : undefined;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

async function latestReusableRelease(): Promise<{ asset: ReleaseAsset; release: Release }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "doctor-toolkit-builder",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  let releases: Release[];
  try {
    releases = JSON.parse(command("gh", [
      "api",
      `repos/${repository}/releases?per_page=100`,
    ])) as Release[];
  } catch {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
      headers,
    });
    if (!response.ok) throw new Error(`GitHub releases request failed: HTTP ${response.status}`);
    releases = (await response.json()) as Release[];
  }
  const current = parseVersion(currentVersion);
  if (!current) throw new Error(`invalid Toolkit version: ${currentVersion}`);
  for (const release of releases
    .filter((item) => !item.draft && parseVersion(item.tag_name))
    .sort((left, right) => compareVersion(parseVersion(right.tag_name)!, parseVersion(left.tag_name)!))) {
    const version = parseVersion(release.tag_name)!;
    if (compareVersion(version, current) > 0) continue;
    const asset = release.assets.find((item) =>
      item.name === `doctor-toolkit-${version.join(".")}-linux-${architecture}.tar`);
    if (asset) return { asset, release };
  }
  throw new Error(`no reusable linux/${architecture} Toolkit release asset found`);
}

function previousBuildKey(toolkitArchive: string): string {
  const buildManifestPath = "doctor-toolkit/build-manifest.json";
  const entries = command("tar", ["-tf", toolkitArchive]).trim().split("\n");
  if (!entries.includes(buildManifestPath)) {
    throw new Error("previous asset is missing its build manifest");
  }
  const manifest = readJsonEntry(toolkitArchive, buildManifestPath);
  if (manifest.schema !== "doctor.toolkit.build/v1" || !Array.isArray(manifest.groups)) {
    throw new Error("previous asset has an invalid build manifest");
  }
  const group = (manifest.groups as Array<Record<string, unknown>>).find((candidate) => {
    const platform = candidate.platform as Record<string, unknown> | undefined;
    return candidate.kind === "packages"
      && platform?.os === "linux"
      && platform.architecture === architecture;
  });
  if (group === undefined) throw new Error("previous asset is missing its package build group");
  if (typeof group.key !== "string" || !/^sha256:[0-9a-f]{64}$/.test(group.key)) {
    throw new Error("previous asset has an invalid package build key");
  }
  return group.key;
}

async function downloadAsset(asset: ReleaseAsset, tag: string): Promise<string> {
  mkdirSync(cacheRoot, { recursive: true });
  const cached = join(cacheRoot, `${tag}-${asset.name}`);
  const expectedDigest = asset.digest?.replace(/^sha256:/, "");
  if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error(`release asset is missing a SHA-256 digest: ${asset.name}`);
  }
  if (
    existsSync(cached)
    && statSync(cached).size === asset.size
    && await sha256(cached) === expectedDigest
  ) return cached;

  const temporary = `${cached}.part-${process.pid}`;
  rmSync(temporary, { force: true });
  const response = await fetch(asset.browser_download_url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`asset download failed: HTTP ${response.status}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary));
    if (statSync(temporary).size !== asset.size) throw new Error("downloaded asset size mismatch");
    if (await sha256(temporary) !== expectedDigest) {
      throw new Error("downloaded asset SHA-256 mismatch");
    }
    renameSync(temporary, cached);
  } finally {
    rmSync(temporary, { force: true });
  }
  return cached;
}

async function packageResource(
  toolkitArchive: string,
  temporaryRoot: string,
): Promise<{ path: string; previousVersion: string }> {
  const manifest = readJsonEntry(toolkitArchive, "doctor-toolkit/manifest.json");
  if (manifest.schema !== "doctor.toolkit/v3" || typeof manifest.version !== "string") {
    throw new Error("previous asset has an invalid Toolkit manifest");
  }
  const platforms = manifest.platforms as Array<Record<string, unknown>>;
  const platform = platforms.find((item) =>
    item.os === "linux" && item.architecture === architecture);
  const resources = platform?.packages as ToolkitResource[] | undefined;
  if (!resources || resources.length !== 1) {
    throw new Error(`previous asset does not contain one linux/${architecture} package set`);
  }
  const resource = resources[0]!;
  if (!/^doctor-toolkit\/platforms\/linux-(?:amd64|arm64)\/packages\/[^/]+\.tar$/.test(resource.path)) {
    throw new Error(`invalid package resource path: ${resource.path}`);
  }
  const output = join(temporaryRoot, basename(resource.path));
  extractEntry(toolkitArchive, resource.path, output);
  if (statSync(output).size !== resource.size || await sha256(output) !== resource.sha256) {
    throw new Error("previous package resource checksum mismatch");
  }
  return { path: output, previousVersion: manifest.version };
}

function validateVariants(packageSet: string): PackageVariant[] {
  const manifest = readJsonEntry(packageSet, "doctor-package-set/manifest.json");
  if (manifest.schema !== "doctor-package-set/v1" || !Array.isArray(manifest.variants)) {
    throw new Error("previous asset has an invalid package set manifest");
  }
  const variants = manifest.variants as PackageVariant[];
  if (variants.length !== expectedVersions.size) {
    throw new Error("previous package set variant count changed");
  }
  for (const variant of variants) {
    const expected = expectedVersions.get(variant.id);
    if (
      !expected
      || variant.manifest.architecture !== architecture
      || variant.manifest.osId !== "debian"
      || variant.manifest.osVersionId !== "12"
      || variant.manifest.packageVersions.gdb !== expected
    ) throw new Error(`previous package variant no longer matches: ${variant.id}`);
  }
  return variants;
}

async function rewrapVariants(
  packageSet: string,
  variants: PackageVariant[],
  temporaryRoot: string,
): Promise<string[]> {
  const arguments_: string[] = [];
  for (const variant of variants) {
    if (!/^doctor-package-set\/variants\/[0-9A-Za-z][0-9A-Za-z._+-]*\.tar$/.test(variant.path)) {
      throw new Error(`invalid package variant path: ${variant.path}`);
    }
    const source = join(temporaryRoot, `${variant.id}-source.tar`);
    extractEntry(packageSet, variant.path, source);
    if (await sha256(source) !== variant.sha256) {
      throw new Error(`previous package variant checksum mismatch: ${variant.id}`);
    }
    const entries = command("tar", ["-tf", source]).trim().split("\n").filter(Boolean);
    if (entries.some((entry) =>
      entry.startsWith("/") || entry.split("/").includes("..") || !entry.startsWith("doctor-packages"))) {
      throw new Error(`previous package variant has unsafe entries: ${variant.id}`);
    }
    const extracted = join(temporaryRoot, `${variant.id}-root`);
    mkdirSync(extracted, { recursive: true });
    command("tar", ["-xf", source, "-C", extracted]);
    const manifestPath = join(extracted, "doctor-packages", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.bundleVersion = currentVersion;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const target = join(temporaryRoot, `${variant.id}.tar`);
    command("tar", [
      "--sort=name",
      "--mtime=UTC 1970-01-01",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-C",
      extracted,
      "-cf",
      target,
      "doctor-packages",
    ]);
    arguments_.push(`${variant.id}=${target}`);
  }
  return arguments_;
}

async function reuse(group: BuildGroup): Promise<void> {
  if (!/^(amd64|arm64)$/.test(architecture)) throw new Error(`unsupported architecture: ${architecture}`);
  if (process.env.REUSE_RELEASE_ASSETS === "false") throw new Error("release asset reuse disabled");
  const { asset, release } = await latestReusableRelease();
  const archive = await downloadAsset(asset, release.tag_name);
  const previousKey = previousBuildKey(archive);
  if (previousKey !== group.key) {
    throw new Error(`package build inputs changed since ${release.tag_name}`);
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "doctor-package-reuse-"));
  try {
    const previous = await packageResource(archive, temporaryRoot);
    const variants = validateVariants(previous.path);
    const prepared = join(temporaryRoot, basename(outputArg));
    if (previous.previousVersion === currentVersion) {
      copyFileSync(previous.path, prepared);
    } else {
      const variantArgs = await rewrapVariants(previous.path, variants, temporaryRoot);
      command(process.execPath, [
        join(toolkitRoot, "scripts", "build-package-set.ts"),
        currentVersion,
        prepared,
        ...variantArgs,
      ]);
    }
    mkdirSync(dirname(resolve(outputArg)), { recursive: true });
    renameSync(prepared, resolve(outputArg));
    console.log(`package set reused from ${release.tag_name}: ${resolve(outputArg)}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const group = await currentBuildGroup();
  writeBuildGroup(group);
  await reuse(group);
} catch (error) {
  console.warn(
    `package set reuse unavailable; building normally: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(10);
}
