import type { Inspect } from "../inspection";
import type { EvidenceBundle } from "../evidence";
import { failReason } from "../../infra/k8s/result";
import { fillFromExec } from "../exec-step";
import type { ExecTarget, Executor } from "../../infra/k8s/executor";
import type { ContainerInfo } from "../../infra/k8s/target";
import {
  parseProcscan,
  pickPid,
  PROCESS_SCAN_SOURCE,
  processScanCmd,
  type ProcScan,
} from "./process";
import { parseContainerResourceUsage, type ContainerResourceUsage } from "./resource-usage";
import { parsePlatformFacts, platformFactsCmd, type ContainerPlatformFacts } from "./platform";
import { inspectK8sAccess } from "../../infra/k8s/access";
import { infra } from "../../infra";
import type { DebugEnvironmentFacts } from "../../infra/target/debug";
import {
  cgroupMemoryCmd,
  parseCgroupMemoryFacts,
  type CgroupMemoryFacts,
} from "./cgroup-memory";
import { collectedFact, type CollectedFact } from "../protocol";

export interface CommonTargetFacts {
  kubernetes: CollectedFact<{
    podsExec: boolean;
    podsEphemeralContainers: boolean;
  }, "target.kubernetes-access">;
  container: CollectedFact<{ python3: boolean; gdb: boolean; proc: boolean }, "target.container-capabilities">;
  resourceUsage?: CollectedFact<ContainerResourceUsage, "target.resource-usage">;
  platform?: CollectedFact<ContainerPlatformFacts, "target.platform">;
  processScan?: CollectedFact<ProcScan & { pickedPid?: number }, "target.process-scan">;
  debug?: CollectedFact<DebugEnvironmentFacts, "target.debug-environment">;
  cgroupMemory?: CollectedFact<CgroupMemoryFacts, "target.cgroup-memory">;
}

export interface CgroupMemoryTargetFacts {
  cgroupMemory?: CollectedFact<CgroupMemoryFacts, "target.cgroup-memory">;
}

export function makeCgroupMemoryInspect(
  stepId = "cgroup-memory-facts",
): Inspect<CgroupMemoryTargetFacts, CommonTargetInspectContext> {
  return {
    id: "cgroup-memory",
    run: async (ctx) => {
      const result = await ctx.exec.exec(ctx.target, cgroupMemoryCmd(), { timeoutMs: 10_000 });
      const cgroupMemory = result.ok ? parseCgroupMemoryFacts(result.stdout) : undefined;
      ctx.bundle.addStep({
        id: stepId,
        title: "cgroup 内存事实",
        risk: "observe",
        status: cgroupMemory ? "ok" : "failed",
        reason: cgroupMemory
          ? undefined
          : result.ok ? "无法解析目标容器的 cgroup 内存事实" : failReason(result),
        command: result.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: result.stdout,
        stderr: result.stderr,
      });
      return cgroupMemory
        ? { cgroupMemory: collectedFact("target.cgroup-memory", "cgroup-memory", cgroupMemory) }
        : {};
    },
  };
}

export function makePlatformInspect(): Inspect<
  CommonTargetFacts,
  CommonTargetInspectContext
> {
  return {
    id: "platform",
    dependsOn: ["container-capabilities"],
    run: async (ctx, facts) => {
      if (!(facts.kubernetes?.podsExec && facts.container?.python3)) return {};
      const result = await ctx.exec.exec(ctx.target, platformFactsCmd(), { timeoutMs: 10_000 });
      fillFromExec(ctx.bundle, "platform-facts", result, "json");
      if (!result.ok) return {};
      const platform = parsePlatformFacts(result.stdout);
      return platform ? { platform: collectedFact("target.platform", "platform", platform) } : {};
    },
  };
}

export interface CommonTargetInspectContext {
  exec: Executor;
  target: ExecTarget;
  podName: string;
  container: ContainerInfo;
  bundle: EvidenceBundle;
  podJson: string;
}

export function makeDebugInspect(): Inspect<
  CommonTargetFacts,
  CommonTargetInspectContext
> {
  return {
    id: "debug",
    run: async (ctx) => {
      const debug = infra.target.debugEngine.inspect(ctx.podJson, ctx.container.name);
      ctx.bundle.addStep({
        id: "debug-facts",
        title: "Doctor Debug Environment Facts",
        risk: "observe",
        status: "ok",
        output: `${JSON.stringify(debug, null, 2)}\n`,
        ext: "json",
      });
      return { debug: collectedFact("target.debug-environment", "debug", debug) };
    },
  };
}

export function makeResourceUsageInspect(): Inspect<
  CommonTargetFacts,
  CommonTargetInspectContext
> {
  return {
    id: "resource-usage",
    run: async (ctx) => {
      const result = await ctx.exec.run([
        "top",
        "pod",
        ctx.podName,
        "--containers",
        "--no-headers",
      ], { timeoutMs: 20_000 });
      const resourceUsage = result.ok
        ? parseContainerResourceUsage(result.stdout, ctx.podName, ctx.container)
        : undefined;
      ctx.bundle.addStep({
        id: "resource-usage-facts",
        title: "容器 CPU/内存占用 Facts",
        risk: "observe",
        status: resourceUsage ? "ok" : "unavailable",
        reason: resourceUsage
          ? undefined
          : result.ok
            ? `kubectl top 未返回容器 ${ctx.container.name} 的资源数据`
            : failReason(result),
        command: result.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: resourceUsage ? `${JSON.stringify(resourceUsage, null, 2)}\n` : result.stdout,
        stderr: result.stderr,
        ext: resourceUsage ? "json" : "txt",
      });
      return resourceUsage
        ? { resourceUsage: collectedFact("target.resource-usage", "resource-usage", resourceUsage) }
        : {};
    },
  };
}

export function makeContainerCapabilitiesInspect(): Inspect<
  CommonTargetFacts,
  CommonTargetInspectContext
> {
  return {
    id: "container-capabilities",
    run: async (ctx) => {
      const access = await inspectK8sAccess(
        ctx.exec,
        { verb: "create", resource: "pods/exec" },
      );
      const canI = access.result;
      const canExec = access.status === "allowed";
      ctx.bundle.addStep({
        id: "cap-exec",
        title: "pods/exec 权限探测",
        risk: "observe",
        status: /^(yes|no)/.test(canI.stdout.trim()) || canI.ok ? "ok" : "failed",
        reason: canExec ? undefined : "无 pods/exec 权限，容器内检查不可用",
        command: canI.command,
        exitCode: canI.exitCode,
        durationMs: canI.durationMs,
        output: canI.stdout,
        stderr: canI.stderr,
      });

      const ephemeralAccess = await inspectK8sAccess(
        ctx.exec,
        { verb: "update", resource: "pods/ephemeralcontainers" },
      );
      const ephemeralCanI = ephemeralAccess.result;
      const canUpdateEphemeralContainers = ephemeralAccess.status === "allowed";
      ctx.bundle.addStep({
        id: "cap-ephemeral-containers",
        title: "pods/ephemeralcontainers 权限探测",
        risk: "observe",
        status: /^(yes|no)/.test(ephemeralCanI.stdout.trim()) || ephemeralCanI.ok
          ? "ok"
          : "failed",
        reason: canUpdateEphemeralContainers
          ? undefined
          : "无 pods/ephemeralcontainers 更新权限，临时调试容器不可用",
        command: ephemeralCanI.command,
        exitCode: ephemeralCanI.exitCode,
        durationMs: ephemeralCanI.durationMs,
        output: ephemeralCanI.stdout,
        stderr: ephemeralCanI.stderr,
      });

      let hasPython = false;
      let hasGdb = false;
      let hasProc = false;
      if (canExec) {
        const capability = await ctx.exec.exec(ctx.target, [
          "sh",
          "-c",
          "command -v python3 >/dev/null 2>&1 && echo python3=yes || echo python3=no; command -v gdb >/dev/null 2>&1 && echo gdb=yes || echo gdb=no; test -r /proc/1/status && echo proc=yes || echo proc=no",
        ], { timeoutMs: 20_000 });
        ctx.bundle.addStep({
          id: "cap-container",
          title: "容器内能力探测（python3 / gdb / /proc）",
          risk: "observe",
          status: capability.ok ? "ok" : "failed",
          reason: capability.ok ? undefined : failReason(capability),
          command: capability.command,
          exitCode: capability.exitCode,
          durationMs: capability.durationMs,
          output: capability.stdout,
          stderr: capability.stderr,
        });
        hasPython = capability.stdout.includes("python3=yes");
        hasGdb = capability.stdout.includes("gdb=yes");
        hasProc = capability.stdout.includes("proc=yes");
      }
      return {
        kubernetes: collectedFact("target.kubernetes-access", "container-capabilities", {
          podsExec: canExec,
          podsEphemeralContainers: canUpdateEphemeralContainers,
        }),
        container: collectedFact("target.container-capabilities", "container-capabilities", {
          python3: hasPython,
          gdb: hasGdb,
          proc: hasProc,
        }),
      };
    },
  };
}

export function makeProcessInspect(
  outcomeId: string,
  options: { requireProc: boolean; pidFlag?: string },
): Inspect<CommonTargetFacts, CommonTargetInspectContext> {
  return {
    id: "process-scan",
    dependsOn: ["container-capabilities"],
    run: async (ctx, facts) => {
      if (
        !facts.kubernetes?.podsExec
        || !facts.container?.python3
        || (options.requireProc && !facts.container?.proc)
      ) return {};
      const result = await ctx.exec.exec(ctx.target, processScanCmd(), {
        stdin: PROCESS_SCAN_SOURCE,
        timeoutMs: 60_000,
      });
      fillFromExec(ctx.bundle, outcomeId, result);
      if (!result.ok) return {};
      const processScan = parseProcscan(result.stdout);
      const picked = pickPid(processScan, options.pidFlag);
      return {
        processScan: collectedFact("target.process-scan", "process-scan", {
          ...processScan,
          pickedPid: picked.ok ? picked.value : undefined,
        }),
      };
    },
  };
}
