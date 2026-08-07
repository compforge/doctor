import { DOCTOR_CLI_VERSION } from "../app/version";

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  version: string;
  requiresDoctor: string;
  contentDigest: string;
  main: string;
  skills: string[];
}

function safeRelativePath(path: string): boolean {
  return path.startsWith("./")
    && !path.includes("\\")
    && !path.split("/").some((part) => part === "..");
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

export function parsePluginRef(ref: string): { id: string; version: string } {
  const separator = ref.lastIndexOf("@");
  const id = separator > 0 ? ref.slice(0, separator) : "";
  const version = separator > 0 ? ref.slice(separator + 1) : "";
  if (!ID_PATTERN.test(id) || !VERSION_PATTERN.test(version)) {
    throw new Error(`Plugin ref must be an exact id@x.y.z: ${ref}`);
  }
  return { id, version };
}

export function parsePluginManifest(raw: string): PluginManifest {
  const value = JSON.parse(raw) as Partial<PluginManifest>;
  if (value.manifestVersion !== 1) {
    throw new Error(`Unsupported Plugin manifest version: ${String(value.manifestVersion)}`);
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new Error(`Invalid Plugin id: ${String(value.id)}`);
  }
  if (typeof value.version !== "string" || !VERSION_PATTERN.test(value.version)) {
    throw new Error(`Invalid Plugin version: ${String(value.version)}`);
  }
  if (typeof value.requiresDoctor !== "string" || !/^>=\d+\.\d+\.\d+$/.test(value.requiresDoctor)) {
    throw new Error(`Plugin requiresDoctor must use >=x.y.z: ${String(value.requiresDoctor)}`);
  }
  const minimum = value.requiresDoctor.slice(2);
  if (compareVersions(DOCTOR_CLI_VERSION, minimum) < 0) {
    throw new Error(
      `Plugin ${value.id}@${value.version} requires doctor ${value.requiresDoctor}; current is ${DOCTOR_CLI_VERSION}`,
    );
  }
  if (typeof value.contentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.contentDigest)) {
    throw new Error("Plugin manifest has no valid contentDigest");
  }
  if (typeof value.main !== "string" || !safeRelativePath(value.main)) {
    throw new Error(`Invalid Plugin main path: ${String(value.main)}`);
  }
  if (
    !Array.isArray(value.skills)
    || !value.skills.every((path) => typeof path === "string" && safeRelativePath(path))
  ) {
    throw new Error("Plugin manifest skills must be safe relative paths");
  }
  return value as PluginManifest;
}
