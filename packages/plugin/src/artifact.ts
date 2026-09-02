import { createHash, type Hash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

export const DOCTOR_PLUGIN_API_VERSION = 7;

const ARTIFACT_DIGEST_DOMAIN = "doctor-plugin-artifact-v1";
const HOST_FILES = new Set(["plugin.json", ".doctor-install.json"]);

function updateHash(hash: Hash, value: string | Buffer): void {
  const content = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(content.length);
  hash.update(length);
  hash.update(content);
}

function artifactFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .filter((entry) => current !== root || !HOST_FILES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(current, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`Plugin artifact must not contain a symlink: ${relative(root, path)}`);
      }
      if (stats.isDirectory()) return artifactFiles(root, path);
      if (stats.isFile()) return [path];
      throw new Error(`Plugin artifact must contain regular files only: ${relative(root, path)}`);
    });
}

/** Digest the exact executable and Skill payload installed by Doctor, excluding Host metadata. */
export function calculatePluginArtifactDigest(pluginRoot: string): string {
  const root = resolve(pluginRoot);
  const hash = createHash("sha256");
  updateHash(hash, ARTIFACT_DIGEST_DOMAIN);
  for (const path of artifactFiles(root)) {
    const stats = lstatSync(path);
    updateHash(hash, relative(root, path).split(sep).join("/"));
    updateHash(hash, (stats.mode & 0o111) === 0 ? "file" : "executable");
    updateHash(hash, readFileSync(path));
  }
  return `sha256:${hash.digest("hex")}`;
}
