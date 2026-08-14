import type { CgroupMemoryFacts } from "../fact/cgroup-memory";
import type { HeapDumpBackendKind, HeapDumpStrategy } from "../../infra/dump";

const MIB = 1024 ** 2;

export interface PyHeapMemoryRiskInput {
  cgroupMemory?: CgroupMemoryFacts;
  targetRssMb?: number;
}

export interface PydumpMemoryRiskInput {
  cgroupMemory?: CgroupMemoryFacts;
  strategy: "debug-container" | "target-container";
}

function parseByteCount(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

/**
 * cgroup 数值仅作为现场事实和失败归因依据，不在采集前做内存余量启发式告警。
 */
export function pydumpMemoryRiskLines(input: PydumpMemoryRiskInput): string[] {
  const location = input.strategy === "debug-container"
    ? "Collector 的图遍历状态和 heap 写入位于 debug container"
    : "Collector 位于目标 container，其图遍历状态和 heap 写入仍受业务 cgroup 约束";
  const lines = [
    `[collect] 内存风险：${location}；目标 Python 进程仅保留有界 Agent 状态，`
      + "但 attach 期间仍会持有 GIL 并暂停业务执行",
  ];
  const currentBytes = parseByteCount(input.cgroupMemory?.currentBytes);
  const limitBytes = parseByteCount(input.cgroupMemory?.limitBytes);
  const cgroupVersion = input.cgroupMemory?.version;

  if (
    cgroupVersion === undefined
    || currentBytes === undefined
    || limitBytes === undefined
    || limitBytes <= 0
  ) {
    return lines;
  }

  const ratio = currentBytes / limitBytes;
  const remainingBytes = Math.max(0, limitBytes - currentBytes);
  lines.push(
    `[collect] 当前目标 cgroup v${cgroupVersion} 内存：`
      + `${formatBytes(currentBytes)} / ${formatBytes(limitBytes)}`
      + `（${(ratio * 100).toFixed(1)}%，剩余 ${formatBytes(remainingBytes)}）`,
  );
  return lines;
}

/**
 * fork-pyheap 的峰值取决于对象数量与引用图；cgroup 数值仅提示风险，不自动选择后端或阻断采集。
 */
export function pyHeapMemoryRiskLines(input: PyHeapMemoryRiskInput): string[] {
  const lines = [
    "[collect] 内存风险：fork-pyheap 会在目标 Python 进程内创建随对象数增长的索引并写入 heap 文件；"
      + "即使通过 debug container 执行，目标 container 内存和 page cache 仍可能显著上升",
  ];
  const currentBytes = parseByteCount(input.cgroupMemory?.currentBytes);
  const limitBytes = parseByteCount(input.cgroupMemory?.limitBytes);
  if (input.cgroupMemory?.version === undefined || currentBytes === undefined || limitBytes === undefined || limitBytes <= 0) {
    return lines;
  }
  const remainingBytes = Math.max(0, limitBytes - currentBytes);
  const targetRssBytes = input.targetRssMb === undefined ? undefined : input.targetRssMb * MIB;
  lines.push(
    `[collect] 当前目标 cgroup v${input.cgroupMemory.version} 内存：`
      + `${formatBytes(currentBytes)} / ${formatBytes(limitBytes)}`
      + `（${(currentBytes / limitBytes * 100).toFixed(1)}%，剩余 ${formatBytes(remainingBytes)}）`
      + (targetRssBytes === undefined ? "" : `；目标 worker RSS：${formatBytes(targetRssBytes)}`),
  );
  return lines;
}

export function memoryBackendRiskLines(
  backend: HeapDumpBackendKind,
  input: {
    cgroupMemory?: CgroupMemoryFacts;
    strategy: HeapDumpStrategy;
    targetRssMb?: number;
  },
): string[] {
  return backend === "pyheap"
    ? pyHeapMemoryRiskLines(input)
    : pydumpMemoryRiskLines(input);
}
