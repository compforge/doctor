import type { CommandContext } from "../../command";
import type { ContainerInfo } from "../../infra/k8s/target";
import type { TerminalProgressUpdate } from "../../terminal/progress";
import type { CommonTargetInspectContext } from "../fact/inspect";
import { PROBE_RUNNABLE, type Probe } from "../protocol";
import {
  captureMemoryHeap,
  type CapturePreference,
  type HeapDumpDetail,
} from "./capture";
import type {
  MemoryCaptureFacts,
  MemoryCaptureObservation,
} from "./capture-diagnosis";
import { cgroupMemoryHint } from "./capture-risk";
import { pyheapBackend } from "../../infra/dump";

export interface MemoryCaptureProbeConfig {
  namespace: string;
  pod: string;
  podUid?: string;
  podJson: string;
  container: ContainerInfo;
  pidFlag?: string;
  detail: HeapDumpDetail;
  strReprLen: number;
  preference: CapturePreference;
  transferChunkBytes: number;
  output?: string;
  invokedAt: Date;
  confirmed: boolean;
}

export interface MemoryCaptureProbeContext extends CommonTargetInspectContext {
  command: CommandContext;
  progress(update: TerminalProgressUpdate): void;
  log(line: string): void;
}

export function makeMemoryCaptureProbe(): Probe<
  MemoryCaptureObservation,
  MemoryCaptureFacts,
  MemoryCaptureProbeConfig,
  MemoryCaptureProbeContext
> {
  return {
    id: "memory-heap-capture",
    evaluate: () => PROBE_RUNNABLE,
    run: async (ctx, facts, config) => {
      const cgroupMemory = facts.cgroupMemory;
      ctx.log(cgroupMemory
        ? `[collect] 检测到目标容器使用 cgroup v${cgroupMemory.version}`
        : "[collect] 未能识别目标容器的 cgroup 版本；继续执行 heap dump");
      ctx.log(`[collect] ${cgroupMemoryHint(cgroupMemory)}`);
      ctx.log(`[collect] heap 采集后端：${pyheapBackend.displayName}`);
      let result;
      try {
        result = await captureMemoryHeap(
          ctx.exec,
          { ...config, cgroupMemory },
          { bundle: ctx.bundle, progress: (update) => ctx.progress(update) },
          ctx.log,
        );
      } catch (error) {
        result = { code: 1, reason: error instanceof Error ? error.message : String(error) };
      }
      return [{
        id: "memory-heap-capture",
        kind: "memory.heap-capture",
        result,
      }];
    },
  };
}
