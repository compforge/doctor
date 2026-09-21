import { infra } from "../../infra";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { failReason } from "../../infra/k8s/result";
import {
  materializePackageBundle,
  type PackageBundle,
  type PackageTargetFact,
} from "../../infra/target/package-install";

import { useLogger } from "../../terminal/log";
import type { InstallPlan } from "./model";

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export interface InstallApplyContext {
  executor: Executor;
  pod: string;
  container: string;
}

export async function applyBundleInstall(input: InstallApplyContext & {
  target: PackageTargetFact;
  packages: readonly string[];
  bundle: PackageBundle;
}): Promise<boolean> {
  const missing = [
    !input.target.pythonAvailable ? "python3（用于可靠上传 tar）" : undefined,
    !input.target.tarAvailable ? "tar" : undefined,
  ].filter(Boolean);
  if (missing.length) {
    useLogger("install").error(`离线安装前置不足：缺少 ${missing.join("、")}`);
    return false;
  }

  const materialized = materializePackageBundle(input.bundle);
  try {
    const remoteTar = `/tmp/doctor-packages-${Date.now().toString(36)}.tar`;
    useLogger("install").info(`Doctor Host -> Target upload: ${input.bundle.path}`
      + `${input.bundle.variant ? `#${input.bundle.variant.id}` : ""}`
      + ` -> pod/${input.pod} container/${input.container}:${remoteTar}`);
    const uploaded = await infra.fileTransfer.uploadToTarget({
      executor: input.executor,
      target: { pod: input.pod, container: input.container },
      hostPath: materialized.path,
      targetPath: remoteTar,
      maxBytes: MAX_BUNDLE_BYTES,
    });
    if (!uploaded.ok) {
      useLogger("install").error(`离线包上传失败：${failReason(uploaded)}`);
      return false;
    }
    try {
      const versionedPackages = input.packages.map((name) => {
        const version = input.bundle.manifest.packageVersions?.[name];
        return version ? `${name}=${version}` : name;
      });
      const installed = await infra.target.packageInstaller.installBundle(
        input.executor,
        input.pod,
        input.container,
        input.target,
        versionedPackages,
        remoteTar,
      );
      if (!installed.ok) {
        useLogger("install").error(`离线安装失败：${failReason(installed)}`);
        return false;
      }
      return true;
    } finally {
      await input.executor.exec(
        { pod: input.pod, container: input.container },
        ["/bin/rm", "-f", remoteTar],
        { timeoutMs: 10_000 },
      );
    }
  } finally {
    materialized.cleanup();
  }
}

export async function applyInstallPlan(
  plan: Exclude<InstallPlan, { kind: "unsupported" }>,
  context: InstallApplyContext,
): Promise<{ installed: boolean; fromBundle: boolean }> {
  if (plan.kind === "offline") {
    useLogger("install").info("正在安装匹配 Target 的离线 GDB");
    const installed = await applyBundleInstall({
      ...context,
      target: plan.target,
      packages: plan.packages,
      bundle: plan.bundle,
    });
    return { installed, fromBundle: installed };
  }

  useLogger("install").info(`正在通过 ${plan.target.manager.kind} 安装：${plan.packages.join(", ")}`);
  const online = await infra.target.packageInstaller.installOnline(
    context.executor,
    context.pod,
    context.container,
    plan.target,
    plan.packages,
  );
  if (!online.ok) {
    useLogger("install").warn(`在线安装失败：${failReason(online)}`);
  }
  return { installed: online.ok, fromBundle: false };
}
