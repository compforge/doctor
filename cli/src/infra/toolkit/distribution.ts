import { existsSync, readdirSync } from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectToolkitArchive, materializeToolkitResource } from "./archive";
import type {
  ResolvedToolkitBundle,
  ResolvedToolkitResource,
  ToolkitArchive,
  ToolkitBundle,
  ToolkitBundleRequest,
  ToolkitChannel,
  ToolkitPlatform,
  ToolkitPlatformManifest,
  ToolkitResourceKind,
} from "./model";
import { targetRequirementsMatch } from "../target/requirements";

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

function platformFor(
  archive: ToolkitArchive,
  platform: ToolkitPlatform,
): ToolkitPlatformManifest | undefined {
  return archive.manifest.platforms.find(
    (item) => item.os === platform.os && item.architecture === platform.architecture,
  );
}

function resourcesFor(
  archive: ToolkitArchive,
  platform: ToolkitPlatform,
  kind: ToolkitResourceKind,
) {
  const selected = platformFor(archive, platform);
  if (!selected) return [];
  if (kind === "tool") return selected.tools;
  if (kind === "image") return selected.images;
  return selected.packages;
}

function numericVersion(value: string): number[] | undefined {
  const match = /^(\d+(?:\.\d+)+)/.exec(value);
  return match?.[1]?.split(".").map(Number);
}

function compareNumericVersions(left: string, right: string): number | undefined {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  if (!leftParts || !rightParts) return undefined;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function compatibleBundle(bundle: ToolkitBundle, request: ToolkitBundleRequest): boolean {
  if (bundle.id !== request.id || bundle.protocol !== request.protocol) return false;
  if (request.runtime) {
    if (
      bundle.compatibility?.runtime?.name !== request.runtime.name
      || bundle.compatibility.runtime.version !== request.runtime.version
    ) return false;
  }
  if (request.libc) {
    const libc = bundle.compatibility?.libc;
    const compared = libc?.family === request.libc.family
      ? compareNumericVersions(request.libc.version, libc.minimumVersion)
      : undefined;
    if (compared === undefined || compared < 0) return false;
  }
  return true;
}

function preferredBundle(left: ToolkitBundle, right: ToolkitBundle): number {
  const leftMinimum = left.compatibility?.libc?.minimumVersion;
  const rightMinimum = right.compatibility?.libc?.minimumVersion;
  if (!leftMinimum || !rightMinimum) return 0;
  return compareNumericVersions(rightMinimum, leftMinimum) ?? 0;
}

/** Resolve every component of a compatible bundle from the same Toolkit archive. */
export function resolveToolkitBundle(
  channel: ToolkitChannel,
  request: ToolkitBundleRequest,
  archives: readonly ToolkitArchive[] = discoverToolkitArchives(),
): ResolvedToolkitBundle | undefined {
  archiveLoop: for (const archive of archives) {
    const platform = platformFor(archive, channel.platform);
    const bundle = platform?.bundles
      .filter((item) => compatibleBundle(item, request))
      .sort(preferredBundle)[0];
    if (!platform || !bundle) continue;
    const components: Record<string, ResolvedToolkitResource> = {};
    for (const component of bundle.components) {
      const resource = (component.kind === "tool"
        ? platform.tools
        : component.kind === "image"
          ? platform.images
          : platform.packages
      ).find((item) => (
        item.id === component.resourceId
        && (component.resourceVersion === undefined || item.version === component.resourceVersion)
      ));
      // Archive validation makes this unreachable; keep the resolver total for injected manifests.
      if (!resource) return undefined;
      if (resource.requirements
        && !targetRequirementsMatch(resource.requirements, request.target ?? {})) {
        continue archiveLoop;
      }
      components[component.role] = {
        archive,
        platform: channel.platform,
        kind: component.kind,
        resource,
        path: materializeToolkitResource(archive, resource, component.kind === "tool"),
      };
    }
    return { archive, platform: channel.platform, bundle, components };
  }
  return undefined;
}

export function resolveToolkitResource(
  channel: ToolkitChannel,
  kind: ToolkitResourceKind,
  id: string,
): ResolvedToolkitResource | undefined {
  for (const archive of discoverToolkitArchives()) {
    const resource = resourcesFor(archive, channel.platform, kind)
      .filter((item) => item.id === id)
      .sort((left, right) => compareNumericVersions(
        right.version ?? "",
        left.version ?? "",
      ) ?? right.version?.localeCompare(left.version ?? "", undefined, { numeric: true }) ?? 0)[0];
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
