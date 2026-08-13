import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inspectPackageBundle } from "./archive";
import type { PackageBundle } from "./model";
import { inspectPackageBundleSet } from "./set";
import {
  inspectToolkitArchive,
  kubernetesToolkitChannel,
  materializeToolkitResource,
  resolveToolkitResources,
} from "../../toolkit";

export function inspectPackageBundles(path: string): PackageBundle[] {
  try {
    return [inspectPackageBundle(path)];
  } catch (bundleError) {
    try {
      return inspectPackageBundleSet(path);
    } catch (setError) {
      try {
        const toolkit = inspectToolkitArchive(path);
        return toolkit.manifest.platforms.flatMap((platform) => {
          if (platform.os !== "linux") return [];
          return platform.packages.flatMap((resource) => inspectPackageBundles(
            materializeToolkitResource(toolkit, resource),
          ));
        });
      } catch (toolkitError) {
        throw new Error(
          `无法读取 Doctor package/Toolkit 交付物 ${path}：`
          + `${bundleError instanceof Error ? bundleError.message : String(bundleError)}；`
          + `${setError instanceof Error ? setError.message : String(setError)}；`
          + `${toolkitError instanceof Error ? toolkitError.message : String(toolkitError)}`,
        );
      }
    }
  }
}

export function discoverPackageBundles(directory: string): PackageBundle[] {
  const bundles: PackageBundle[] = [];
  for (const name of readdirSync(directory)) {
    if (!/^doctor-packages-.+\.tar$/.test(basename(name))) continue;
    try {
      bundles.push(...inspectPackageBundles(resolve(directory, name)));
    } catch {
      // 当前目录可能同时存在其它平台或未完成文件；显式 --tar 时才把格式错误交给用户。
    }
  }
  for (const architecture of ["amd64", "arm64"] as const) {
    const channel = kubernetesToolkitChannel({
      pod: "package-discovery",
      container: "package-discovery",
      architecture,
    });
    if (!channel) continue;
    for (const resource of resolveToolkitResources(channel, "package")) {
      try {
        bundles.push(...inspectPackageBundles(resource.path));
      } catch {
        // A Toolkit may contain package formats not consumed by this installer.
      }
    }
  }
  return bundles;
}
