#!/usr/bin/env bun

import { createHash, type Hash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const LOCK_FILE = "plugin-version.lock.json";
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const CONTENT_DIRECTORIES = ["src", "skills"] as const;
const IGNORED_NAMES = new Set([
  ".DS_Store",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
]);

interface PluginPackage {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface PluginVersionLock {
  schemaVersion: 1;
  pluginId: string;
  version: string;
  contentDigest: string;
}

function parseVersion(value: string): [number, number, number] {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Plugin version must be x.y.z: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function nextPatch(version: string): string {
  const [major, minor, patch] = parseVersion(version);
  return `${major}.${minor}.${patch + 1}`;
}

function updateHash(hash: Hash, value: string | Buffer): void {
  const content = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(content.length);
  hash.update(length);
  hash.update(content);
}

function ignored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.endsWith(".pyc");
}

function contentFiles(root: string, current: string): string[] {
  return readdirSync(current, { withFileTypes: true })
    .filter((entry) => !ignored(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin content must not be a symlink: ${relative(root, path)}`);
      }
      if (entry.isDirectory()) return contentFiles(root, path);
      if (entry.isFile()) return [path];
      throw new Error(`Plugin content must be a regular file: ${relative(root, path)}`);
    });
}

export function calculatePluginContentDigest(pluginRoot: string): string {
  const root = resolve(pluginRoot);
  const files = CONTENT_DIRECTORIES.flatMap((directory) => {
    const path = resolve(root, directory);
    return existsSync(path) ? contentFiles(root, path) : [];
  }).sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  updateHash(hash, "doctor-plugin-content-v1");
  for (const path of files) {
    const mode = (statSync(path).mode & 0o111) === 0 ? "file" : "executable";
    updateHash(hash, relative(root, path).split(sep).join("/"));
    updateHash(hash, mode);
    updateHash(hash, readFileSync(path));
  }
  return `sha256:${hash.digest("hex")}`;
}

function packagePath(pluginRoot: string): string {
  return resolve(pluginRoot, "package.json");
}

function lockPath(pluginRoot: string): string {
  return resolve(pluginRoot, LOCK_FILE);
}

function readPackage(pluginRoot: string): PluginPackage {
  const path = packagePath(pluginRoot);
  if (!existsSync(path)) throw new Error(`Plugin workspace has no package.json: ${pluginRoot}`);
  const metadata = JSON.parse(readFileSync(path, "utf8")) as PluginPackage;
  if (!metadata.name) throw new Error(`Plugin package has no name: ${path}`);
  if (!metadata.version) throw new Error(`Plugin package has no version: ${path}`);
  parseVersion(metadata.version);
  return metadata;
}

function readLock(pluginRoot: string): PluginVersionLock {
  const path = lockPath(pluginRoot);
  if (!existsSync(path)) {
    throw new Error(`Plugin version lock is missing: ${path}; run version.ts init first`);
  }
  const lock = JSON.parse(readFileSync(path, "utf8")) as Partial<PluginVersionLock>;
  if (
    lock.schemaVersion !== 1
    || typeof lock.pluginId !== "string"
    || typeof lock.version !== "string"
    || typeof lock.contentDigest !== "string"
  ) {
    throw new Error(`Plugin version lock is invalid: ${path}`);
  }
  parseVersion(lock.version);
  return lock as PluginVersionLock;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function initializePluginVersion(pluginRoot: string): PluginVersionLock {
  const root = resolve(pluginRoot);
  if (existsSync(lockPath(root))) {
    throw new Error(`Plugin version lock already exists: ${lockPath(root)}`);
  }
  const metadata = readPackage(root);
  const lock: PluginVersionLock = {
    schemaVersion: 1,
    pluginId: basename(root),
    version: metadata.version!,
    contentDigest: calculatePluginContentDigest(root),
  };
  writeJson(lockPath(root), lock);
  return lock;
}

export function checkPluginVersion(pluginRoot: string): PluginVersionLock {
  const root = resolve(pluginRoot);
  const metadata = readPackage(root);
  const lock = readLock(root);
  if (lock.pluginId !== basename(root)) {
    throw new Error(`Plugin id changed: lock=${lock.pluginId}, directory=${basename(root)}`);
  }
  if (metadata.version !== lock.version) {
    throw new Error(
      `Plugin version is not sealed: package=${metadata.version}, lock=${lock.version}; run version.ts bump`,
    );
  }
  const digest = calculatePluginContentDigest(root);
  if (digest !== lock.contentDigest) {
    throw new Error(
      `Plugin ${lock.pluginId}@${lock.version} content changed without a version bump; run version.ts bump`,
    );
  }
  return lock;
}

export function bumpPluginVersion(
  pluginRoot: string,
  requestedVersion?: string,
): PluginVersionLock {
  const root = resolve(pluginRoot);
  const metadata = readPackage(root);
  const previous = readLock(root);
  const version = requestedVersion ?? nextPatch(previous.version);
  if (compareVersion(version, previous.version) <= 0) {
    throw new Error(`Plugin version must increase from ${previous.version}: ${version}`);
  }
  metadata.version = version;
  writeJson(packagePath(root), metadata);
  const lock: PluginVersionLock = {
    schemaVersion: 1,
    pluginId: previous.pluginId,
    version,
    contentDigest: calculatePluginContentDigest(root),
  };
  writeJson(lockPath(root), lock);
  return lock;
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

function usage(): never {
  throw new Error(
    "usage: version.ts <check|init|bump> <plugin-root> [--version x.y.z]",
  );
}

if (import.meta.main) {
  const [command, pluginRoot] = Bun.argv.slice(2);
  if (!command || !pluginRoot) usage();
  const lock = command === "check"
    ? checkPluginVersion(pluginRoot)
    : command === "init"
    ? initializePluginVersion(pluginRoot)
    : command === "bump"
    ? bumpPluginVersion(pluginRoot, argument("--version"))
    : usage();
  process.stdout.write(
    `${command}: ${lock.pluginId}@${lock.version} (${lock.contentDigest})\n`,
  );
}
