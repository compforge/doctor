import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  resolvePodTarget,
} from "../../command/kubernetes-target";
import { infra } from "../../infra";
import { approvalDeniedReason } from "../../command/approval";
import { resolveApprovalGate } from "../../terminal/approval";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import type { CommandContext } from "../../command";
import {
  applyBundleInstall,
  applyInstallPlan,
} from "./apply";
import {
  bundleDescription,
  inspectInstallBundle,
  inspectInstallBundleCandidates,
  inspectInstallTarget,
  packageBundleMissingMessage,
  targetDescription,
} from "./inspect";
import type { InstallCliOpts } from "./model";
import {
  buildInstallPlan,
  installPlanImpact,
} from "./plan";
import {
  gdbReady,
  verifyGdbCapability,
} from "./verify";
import {
  parseInstallProgram,
  promptInstallProgram,
} from "./program";
import {
  packageBundleReport,
  writeInstallCompatibilityReport,
  type InstallCompatibilityReport,
} from "./report";

export function validateInstallOptions(opts: InstallCliOpts): void {
  const reportFormat = opts.format?.trim().toLowerCase();
  if (reportFormat && reportFormat !== "md" && reportFormat !== "json") {
    throw new Error(`--format 只支持 md 或 json：'${opts.format}'`);
  }
  const configuredProgram = opts.program ? parseInstallProgram(opts.program) : undefined;
  if (!configuredProgram && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("当前为非交互终端；请显式指定 --program gdb");
  }
}

export async function runInstall(
  opts: InstallCliOpts,
  commandContext: CommandContext,
): Promise<number> {
  validateInstallOptions(opts);
  const configuredProgram = opts.program ? parseInstallProgram(opts.program) : undefined;
  const config = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!config) return 130;
  const executor = createKubernetesExecutor(config);
  const access = commandContext.kubernetes(executor).access;
  await enforceKubernetesAccess(access, {
    command: "doctor install",
    needs: [{
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "探测并向目标 Container 安装程序",
    }],
  });
  const selected = await resolvePodTarget({
    config,
    executor,
    pod: opts.pod,
    container: opts.container,
    selectContainer: true,
    includeEphemeralContainers: true,
    access,
    selection: {
      candidateRole: "目标",
      purpose: "探测并安装诊断程序",
    },
  });
  if (!selected?.container) return 130;
  const program = configuredProgram ?? await promptInstallProgram();
  if (!program) return 130;
  const packages = [program];

  const target = await inspectInstallTarget(executor, selected.pod, selected.container);
  if (!target) {
    terminalStderr.error(
      `[install] pod/${selected.pod} container/${selected.container} 中未发现`
      + " apt-get、apk、dnf、microdnf 或 yum\n",
    );
    return 1;
  }
  terminalStdout.write(
    `[install] target: pod/${selected.pod} container/${selected.container}`
    + `（${targetDescription(target)}）\n`,
  );

  const existingGdb = await verifyGdbCapability(executor, selected.pod, selected.container);
  let finalGdb = existingGdb;
  let bundleCandidates = [] as ReturnType<typeof inspectInstallBundleCandidates>;
  let selectedBundle: ReturnType<typeof inspectInstallBundle> = undefined;
  const finish = (
    code: number,
    status: InstallCompatibilityReport["result"]["status"],
    stage: string,
    reason: string,
  ): number => {
    const report: InstallCompatibilityReport = {
      schema: "doctor.install-compatibility/v1",
      generatedAt: new Date().toISOString(),
      target: {
        namespace: config.kubernetes.namespace,
        pod: selected.pod,
        container: selected.container!,
        runtime: target,
      },
      gdb: {
        before: existingGdb,
        after: finalGdb === existingGdb ? undefined : finalGdb,
      },
      packageBundles: packageBundleReport(bundleCandidates, target, packages, selectedBundle),
      result: { status, stage, reason },
    };
    const path = writeInstallCompatibilityReport(opts, report);
    if (path) terminalStdout.info(`[install] GDB 兼容性报告：${path}\n`);
    return code;
  };
  if (gdbReady(existingGdb)) {
    terminalStdout.success(
      `[install] GDB ${existingGdb.version ?? "version unknown"} ready`
      + "（Python scripting 与 inferior call 验收通过）\n",
    );
    return finish(0, "ready", "preflight", "现有 GDB 已满足 PyHeap 能力契约");
  }
  if (existingGdb.available) {
    terminalStdout.warning(
      `[install] 已有 GDB ${existingGdb.version ?? ""}，但 `
      + `${existingGdb.reason ?? "PyHeap 所需能力验收未通过"}；`
      + `尝试通过 ${target.manager.kind} 补齐\n`,
    );
  }

  let bundle;
  try {
    bundleCandidates = inspectInstallBundleCandidates(opts.tar, target);
    bundle = inspectInstallBundle(opts.tar, target, packages, bundleCandidates);
    selectedBundle = bundle;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    terminalStderr.error(`[install] ${reason}\n`);
    return finish(1, "failed", "bundle-selection", reason);
  }
  if (bundle) {
    terminalStdout.write(
      `[install] Target kernel ${target.kernelVersion ?? "unknown"} 匹配离线包：`
      + `${bundleDescription(bundle)}\n`,
    );
  }
  const plan = buildInstallPlan({
    target,
    packages,
    explicitBundle: Boolean(opts.tar),
    bundle,
  });
  if (plan.kind === "unsupported") {
    terminalStderr.error(`[install] ${plan.reason}\n`);
    return finish(1, "failed", "plan", plan.reason);
  }
  if (plan.kind === "online") {
    terminalStdout.write(
      "[install] Target 将执行在线安装命令：\n"
      + plan.commands.map((command) => `  $ ${command.join(" ")}`).join("\n")
      + "\n",
    );
  }

  const decision = await resolveApprovalGate(opts)({
    id: `install-packages/${selected.pod}/${selected.container}`,
    risk: "overhead",
    title: `向目标 Container 安装 ${packages.join(", ")}`,
    target: `pod/${selected.pod} container/${selected.container}`,
    impact: [
      "直接修改该 Container 的可写层；Pod 重建后安装结果会丢失",
      installPlanImpact(plan),
      "安装后用 Doctor 自建 Python 进程验收 GDB Python scripting 和 inferior call；"
      + "不会 attach 业务进程",
      "安装过程会产生网络、磁盘和 CPU 开销",
    ],
  });
  if (!decision.approved) {
    terminalStderr.error(`[install] ${approvalDeniedReason(decision.source)}\n`);
    return finish(130, "cancelled", "approval", "用户未批准安装");
  }

  const context = {
    executor,
    pod: selected.pod,
    container: selected.container,
  };
  let { installed, fromBundle: installedFromBundle } = await applyInstallPlan(plan, context);
  const fallbackBundle = plan.kind === "online" ? plan.fallbackBundle : undefined;
  if (!installed) {
    if (plan.kind === "offline") {
      return finish(1, "failed", "offline-install", "离线 GDB 安装失败");
    }
    if (!fallbackBundle) {
      terminalStderr.error(
        target.manager.kind !== "apt-get"
          ? `[install] ${target.manager.kind} 离线包安装尚未支持；在线安装已经失败\n`
          : `[install] ${packageBundleMissingMessage(target)}\n`,
      );
      return finish(1, "failed", "online-install", "在线安装失败且没有匹配的离线 bundle");
    }
    installed = await applyBundleInstall({
      ...context,
      target,
      packages,
      bundle: fallbackBundle,
    });
    installedFromBundle = installed;
  }
  if (!installed) return finish(1, "failed", "fallback-install", "离线 GDB fallback 安装失败");

  const verified = await infra.target.packageInstaller.installed(
    executor,
    selected.pod,
    selected.container,
    target,
    packages,
  );
  if (!verified) {
    terminalStderr.error("[install] 安装命令已完成，但包数据库未确认 GDB 已安装\n");
    return finish(1, "failed", "package-verification", "包数据库未确认 GDB 已安装");
  }

  let gdb = await verifyGdbCapability(executor, selected.pod, selected.container);
  finalGdb = gdb;
  if (!gdbReady(gdb) && fallbackBundle && !installedFromBundle) {
    terminalStdout.warning(
      `[install] 在线 GDB ${gdb.version ?? ""} 与 Target kernel `
      + `${target.kernelVersion ?? "unknown"} 的 inferior call 验收失败；`
      + `改用 ${bundleDescription(fallbackBundle)}\n`,
    );
    installedFromBundle = await applyBundleInstall({
      ...context,
      target,
      packages,
      bundle: fallbackBundle,
    });
    if (installedFromBundle) {
      gdb = await verifyGdbCapability(executor, selected.pod, selected.container);
      finalGdb = gdb;
    }
  }
  if (!gdbReady(gdb)) {
    terminalStderr.error(
      `[install] GDB ${gdb.version ?? ""} 已安装，但 PyHeap 所需能力验收失败：`
      + `${gdb.reason ?? "原因未知"}\n`,
    );
    if (!opts.tar && !bundle && target.manager.kind === "apt-get") {
      terminalStderr.error(`[install] ${packageBundleMissingMessage(target)}\n`);
    }
    return finish(
      1,
      "failed",
      "gdb-capability",
      gdb.reason ?? "GDB 已安装，但 PyHeap 所需能力验收失败",
    );
  }
  terminalStdout.success(
    `[install] 安装完成：pod/${selected.pod} container/${selected.container}：`
    + `GDB ${gdb.version ?? "version unknown"} ready`
    + "（Python scripting 与 inferior call 验收通过）\n",
  );
  return finish(0, "ready", "gdb-capability", "GDB Python scripting 与 inferior call 验收通过");
}
