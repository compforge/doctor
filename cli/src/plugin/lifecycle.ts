import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extractPluginArchive } from "./archive";
import {
  installedPluginPath,
  loadPluginDirectory,
  pluginInstallRoot,
  readActivePluginRef,
  readInstalledManifest,
} from "./loader";

export interface PluginInstallResult {
  ref: string;
  path: string;
  installed: boolean;
}

function writeActivePluginRef(ref: string | undefined, installRoot: string): void {
  const path = join(installRoot, "active.json");
  if (!ref) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ref }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function installPlugin(
  archive: string,
  installRoot = pluginInstallRoot(),
): Promise<PluginInstallResult> {
  const archivePath = resolve(archive);
  if (!existsSync(archivePath)) throw new Error(`Plugin archive not found: ${archive}`);
  mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(installRoot, ".install-"));
  try {
    extractPluginArchive(archivePath, temporary);
    const manifest = readInstalledManifest(temporary);
    const ref = `${manifest.id}@${manifest.version}`;
    await loadPluginDirectory(temporary, ref);
    const manifestRaw = readFileSync(join(temporary, "plugin.json"));
    const destination = installedPluginPath(ref, installRoot);
    if (existsSync(destination)) {
      await loadPluginDirectory(destination, ref);
      const current = readInstalledManifest(destination);
      const currentManifestRaw = readFileSync(join(destination, "plugin.json"));
      if (
        current.contentDigest !== manifest.contentDigest
        || !currentManifestRaw.equals(manifestRaw)
      ) {
        throw new Error(`Plugin ${ref} is already installed with different content`);
      }
      writeActivePluginRef(ref, installRoot);
      return { ref, path: destination, installed: false };
    }
    writeFileSync(join(temporary, ".doctor-install.json"), `${JSON.stringify({
      schemaVersion: 1,
      archiveSha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
      manifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
      contentDigest: manifest.contentDigest,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(temporary, destination);
    writeActivePluginRef(ref, installRoot);
    return { ref, path: destination, installed: true };
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

export function uninstallPlugin(ref: string, installRoot = pluginInstallRoot()): string {
  const destination = installedPluginPath(ref, installRoot);
  if (!existsSync(destination)) throw new Error(`Plugin is not installed: ${ref}`);
  if (readActivePluginRef(installRoot) === ref) writeActivePluginRef(undefined, installRoot);
  rmSync(destination, { recursive: true, force: true });
  const parent = dirname(destination);
  try {
    if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {
    // Parent cleanup is best-effort; the immutable version directory is already removed.
  }
  return destination;
}
