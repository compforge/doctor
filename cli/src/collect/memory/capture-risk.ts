import type { CgroupMemoryFacts } from "../fact/cgroup-memory";

const MIB = 1024 ** 2;

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
