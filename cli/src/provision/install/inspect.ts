import { existsSync } from "node:fs";
import { cwd } from "node:process";
import { infra } from "../../infra";
import type { Executor } from "../../infra/k8s/executor";
import {
  discoverPackageBundles,
  inspectPackageBundles,
  selectPackageBundle,
  type PackageBundle,
  type PackageTargetFact,
} from "../../infra/target/package-install";

export function targetDescription(target: PackageTargetFact): string {
  const platform = [target.osId, target.osVersionId, target.architecture]
    .filter(Boolean)
    .join("/");
  return `${platform || "platform unknown"}，kernel=${target.kernelVersion ?? "unknown"}，`
    + `package manager=${target.manager.kind}`;
}

export function packageBundleMissingMessage(
  target: PackageTargetFact,
  explicitPath?: string,
): string {
  const missing = explicitPath
    ? `指定的 Doctor package bundle 不存在：${explicitPath}`
    : "当前目录没有匹配的 doctor-packages-*.tar";
  return `${missing}。\n`
    + "[install] 该 tar 是 Doctor 独立构建、独立版本的离线软件仓，"
    + "包含匹配 Target 发行版/架构的 GDB、依赖包和兼容性 manifest；"
    + "它不是 image tar，也不是在客户 Pod 内现场生成的文件。\n"
    + `[install] 当前 Target：${targetDescription(target)}。`
    + "请从 Doctor package-bundles 交付物中取得匹配版本，"
    + "或在 Doctor CLI 源码目录运行 `make build-gdb-package-bundles` 构建；"
    + "然后复制到 Doctor Host 当前目录，或用 `--tar <path>` 指定。";
}

export function inspectInstallTarget(
  executor: Executor,
  pod: string,
  container: string,
): Promise<PackageTargetFact | undefined> {
  return infra.target.packageInstaller.inspect(executor, pod, container);
}

export function inspectInstallBundle(
  explicitPath: string | undefined,
  target: PackageTargetFact,
  packages: readonly string[],
  candidates?: PackageBundle[],
): PackageBundle | undefined {
  const bundles = candidates ?? inspectInstallBundleCandidates(explicitPath, target);
  const bundle = selectPackageBundle(bundles, target, packages);
  if (explicitPath && !bundle) {
    throw new Error(
      `离线包与目标或 GDB 不匹配：${explicitPath}；`
      + `目标=${targetDescription(target)}，packages=${packages.join(",")}`,
    );
  }
  return bundle;
}

export function inspectInstallBundleCandidates(
  explicitPath: string | undefined,
  target: PackageTargetFact,
): PackageBundle[] {
  if (target.manager.kind !== "apt-get") return [];
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(packageBundleMissingMessage(target, explicitPath));
    }
    return inspectPackageBundles(explicitPath);
  }
  return discoverPackageBundles(cwd());
}

export function bundleDescription(bundle: PackageBundle): string {
  const version = bundle.manifest.packageVersions?.gdb;
  const kernel = bundle.manifest.compatibility?.kernel;
  const range = kernel
    ? [
        kernel.minInclusive ? `>=${kernel.minInclusive}` : undefined,
        kernel.maxExclusive ? `<${kernel.maxExclusive}` : undefined,
      ].filter(Boolean).join(" ")
    : "未声明范围";
  const variant = bundle.variant ? `，variant ${bundle.variant.id}` : "";
  return `GDB ${version ?? "version unknown"}，kernel ${range}${variant}`;
}
