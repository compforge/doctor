import {
  probeUnavailable,
  PROBE_RUNNABLE,
  type Probe,
} from "../../protocol";
import type { ContainerInfo } from "../../../infra/k8s/target";
import { authorize, type Operation } from "../../operation";
import {
  formatContainerResourceUsage,
  HIGH_RESOURCE_USAGE_RATIO,
  isHighContainerResourceUsage,
} from "../../fact/resource-usage";
import type { CpuDiagnosisFacts } from "../fact/model";
import type { CpuObservation, CpuProbeContext } from "../model";
import type { CpuConfig } from "../config";
import { collectPySpy } from "../py-spy";
import { parseCpuPySpyDump } from "../py-spy-dump";

export interface PySpyProbeOptions {
  podJson: string;
  podName: string;
  container: ContainerInfo;
}

function highResourceUsageOp(options: PySpyProbeOptions, summary: string): Operation {
  return {
    id: "py-spy-high-resource-usage",
    risk: "overhead",
    title: "高负载下执行 py-spy",
    target: `pod/${options.podName} container/${options.container.name}`,
    impact: [
      `当前资源占用：${summary}`,
      `CPU 或内存已达到容器 limit 的 ${HIGH_RESOURCE_USAGE_RATIO * 100}%；py-spy 采样可能进一步增加负载`,
    ],
    steps: [],
  };
}

function shouldRunResourcePreflight(facts: CpuDiagnosisFacts, mode: CpuConfig["mode"]): boolean {
  if (mode === "disrupt") return Boolean(facts.debug?.selected);
  return mode === "overhead"
    && facts.ptrace?.attachLikely === true
    && Boolean(facts.pythonProcess?.pySpyPath);
}

export function makePySpyProbe(
  options: PySpyProbeOptions,
): Probe<CpuObservation, CpuDiagnosisFacts, CpuConfig, CpuProbeContext> {
  return {
    id: "py-spy",
    evaluate: (facts, config) => {
      if (config.mode === "observe") return probeUnavailable("mode=observe 不 attach 目标进程");
      if (!facts.canExec) return probeUnavailable("无 pods/exec 权限");
      if (!facts.hasPython) return probeUnavailable("目标容器没有 python3");
      if (facts.pickedPid === undefined) return probeUnavailable("未定位到目标 Python 进程");
      if (facts.ptrace?.ptraceScope === 3) return probeUnavailable("kernel ptrace_scope=3 禁止 attach");
      if (config.mode === "overhead" && !facts.ptrace?.attachLikely) {
        return probeUnavailable(`${facts.ptrace?.reason ?? "未取得 ptrace Facts"}；可先执行 doctor debug，再使用 --mode disrupt`);
      }
      if (config.mode === "overhead" && !facts.pythonProcess?.pySpyPath) {
        return probeUnavailable("目标容器没有已有 py-spy；可先执行 doctor debug，再使用 --mode disrupt");
      }
      if (config.mode === "disrupt" && !facts.debug?.selected) {
        return probeUnavailable(facts.debug?.reason ?? "目标 Pod 中没有已就绪的 doctor debug 临时容器；请先执行 doctor debug");
      }
      return PROBE_RUNNABLE;
    },
    onUnavailable: (ctx, reason) => ctx.bundle.settle(reason, ["py-spy-dump"]),
    run: async (ctx, facts, config) => {
      const pickedPid = facts.pickedPid!; // evaluate 已保证 pid 存在
      if (shouldRunResourcePreflight(facts, config.mode)) {
        const usage = facts.resourceUsage;
        if (usage) {
          const summary = formatContainerResourceUsage(usage);
          ctx.log(`[collect] py-spy 执行前资源：${summary}`);
          if (isHighContainerResourceUsage(usage)) {
            const auth = await authorize(
              { ...ctx, mode: config.mode },
              highResourceUsageOp(options, summary),
              "目标容器当前负载较高，确认是否继续采集 py-spy 线程栈",
            );
            if (!auth.approved) {
              ctx.bundle.fill("py-spy-dump", { status: "unavailable", reason: auth.reason });
              ctx.notes.push(`py-spy: ${auth.reason}`);
              return [];
            }
          }
        } else {
          ctx.log("[collect] py-spy 执行前资源：Facts 阶段未取得容器 CPU/内存数据");
        }
      }
      let pySpyOutput = "";
      await collectPySpy({
        mode: config.mode,
        exec: ctx.exec,
        bundle: ctx.bundle,
        podJson: options.podJson,
        podName: options.podName,
        container: options.container,
        pid: pickedPid,
        capabilityFacts: facts.pythonProcess,
        ptraceFacts: facts.ptrace,
        debug: facts.debug,
        approvalGate: ctx.approvalGate,
        approvals: ctx.approvals,
        onPySpyDump: (output) => {
          pySpyOutput = output;
        },
        log: ctx.log,
        notes: ctx.notes,
      });
      const observation = parseCpuPySpyDump(pySpyOutput);
      return observation ? [observation] : [];
    },
  };
}
