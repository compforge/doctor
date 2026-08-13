import { existsSync, readdirSync } from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectToolkitArchive, materializeToolkitResource } from "./archive";
import type {
  ResolvedToolkitResource,
  ToolkitArchive,
  ToolkitChannel,
  ToolkitPlatform,
  ToolkitResourceKind,
} from "./model";

let archiveCache: ToolkitArchive[] | undefined;

function candidateLocations(): string[] {
  const configured = process.env.DOCTOR_TOOLKIT?.split(delimiter).filter(Boolean) ?? [];
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceToolkit = resolve(moduleDirectory, "../../../../toolkit");
  return [...new Set([
    ...configured,
    process.cwd(),
    dirname(process.execPath),
    dirname(process.argv[1] ?? process.execPath),
    join(sourceToolkit, "dist"),
  ].map((path) => resolve(path)))];
}

function inspectLocation(path: string): ToolkitArchive[] {
  if (!existsSync(path)) return [];
  if (path.endsWith(".tar")) return [inspectToolkitArchive(path)];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^doctor-toolkit-.+\.tar$/.test(entry.name))
      .flatMap((entry) => {
        try {
          return [inspectToolkitArchive(join(path, entry.name))];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function discoverToolkitArchives(refresh = false): readonly ToolkitArchive[] {
  if (!archiveCache || refresh) {
    const unique = new Map<string, ToolkitArchive>();
    for (const location of candidateLocations()) {
      for (const archive of inspectLocation(location)) unique.set(archive.path, archive);
    }
    archiveCache = [...unique.values()].sort((left, right) =>
      right.manifest.version.localeCompare(left.manifest.version, undefined, { numeric: true }));
  }
  return archiveCache;
}

function resourcesFor(
  archive: ToolkitArchive,
  platform: ToolkitPlatform,
  kind: ToolkitResourceKind,
) {
  const selected = archive.manifest.platforms.find(
    (item) => item.os === platform.os && item.architecture === platform.architecture,
  );
  if (!selected) return [];
  if (kind === "tool") return selected.tools;
  if (kind === "image") return selected.images;
  return selected.packages;
}

export function resolveToolkitResource(
  channel: ToolkitChannel,
  kind: ToolkitResourceKind,
  id: string,
): ResolvedToolkitResource | undefined {
  for (const archive of discoverToolkitArchives()) {
    const resource = resourcesFor(archive, channel.platform, kind).find((item) => item.id === id);
    if (!resource) continue;
    return {
      archive,
      platform: channel.platform,
      kind,
      resource,
      path: materializeToolkitResource(archive, resource, kind === "tool"),
    };
  }
  return undefined;
}

export function resolveToolkitResources(
  channel: ToolkitChannel,
  kind: ToolkitResourceKind,
): ResolvedToolkitResource[] {
  for (const archive of discoverToolkitArchives()) {
    const resources = resourcesFor(archive, channel.platform, kind);
    if (resources.length === 0) continue;
    return resources.map((resource) => ({
      archive,
      platform: channel.platform,
      kind,
      resource,
      path: materializeToolkitResource(archive, resource, kind === "tool"),
    }));
  }
  return [];
}
