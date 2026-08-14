import {
  onlineInstallCommands,
  packageBundleRequirements,
  type PackageBundle,
  type PackageTargetFact,
} from "../../infra/target/package-install";
import type { InstallPlan } from "./model";

export function buildInstallPlan(input: {
  target: PackageTargetFact;
  packages: readonly string[];
  explicitBundle: boolean;
  bundle?: PackageBundle;
}): InstallPlan {
  if (input.explicitBundle && input.target.manager.kind !== "apt-get") {
    return {
      kind: "unsupported",
      target: input.target,
      packages: input.packages,
      reason: `${input.target.manager.kind} 尚不支持 Doctor 离线包安装；`
        + "不能执行已通过 --tar 指定的离线安装计划",
    };
  }
  if (input.explicitBundle && !input.bundle) {
    return {
      kind: "unsupported",
      target: input.target,
      packages: input.packages,
      reason: "已指定 --tar，但没有解析到匹配 Target 的离线包",
    };
  }
  if (input.bundle && (input.explicitBundle || packageBundleRequirements(input.bundle)?.software?.kernel)) {
    return {
      kind: "offline",
      target: input.target,
      packages: input.packages,
      bundle: input.bundle,
      reason: input.explicitBundle ? "explicit" : "kernel-compatible",
    };
  }
  return {
    kind: "online",
    target: input.target,
    packages: input.packages,
    commands: onlineInstallCommands(input.target, input.packages),
    fallbackBundle: input.bundle,
  };
}

export function installPlanImpact(plan: Exclude<InstallPlan, { kind: "unsupported" }>): string {
  if (plan.kind === "offline") {
    return plan.reason === "explicit"
      ? "上传并使用 --tar 指定且与 Target 匹配的 Doctor 离线包"
      : "上传并使用与 Target kernel 匹配的 Doctor 离线包";
  }
  return plan.fallbackBundle
    ? `先通过 ${plan.target.manager.kind} 访问容器已有软件源；`
      + "失败或能力验收不通过时使用当前已匹配的 Doctor 离线包"
    : `通过 ${plan.target.manager.kind} 访问容器已有软件源；`
      + "没有可用的 Doctor 离线 fallback";
}
