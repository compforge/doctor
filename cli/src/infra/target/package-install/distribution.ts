import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { inspectPackageBundle } from "./archive";
import type { PackageBundle } from "./model";
import { inspectPackageBundleSet } from "./set";

export function inspectPackageBundles(path: string): PackageBundle[] {
  try {
    return [inspectPackageBundle(path)];
  } catch (bundleError) {
    try {
      return inspectPackageBundleSet(path);
    } catch (setError) {
      throw new Error(
        `无法读取 Doctor package 交付物 ${path}：`
        + `${bundleError instanceof Error ? bundleError.message : String(bundleError)}；`
        + `${setError instanceof Error ? setError.message : String(setError)}`,
      );
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
  return bundles;
}
