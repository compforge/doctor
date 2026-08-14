import type { CgroupMemoryFacts } from "../fact/cgroup-memory";

const MIB = 1024 ** 2;

export interface PyHeapMemoryRiskInput {
  cgroupMemory?: CgroupMemoryFacts;
  targetRssMb?: number;
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

export function cgroupMemoryHint(cgroup?: CgroupMemoryFacts): string {
  const current = parseByteCount(cgroup?.currentBytes);
  const limit = parseByteCount(cgroup?.limitBytes);
  if (current === undefined || limit === undefined || limit <= 0 || cgroup?.version === undefined) {
    return "目标 cgroup 余量未知";
  }
  const remaining = Math.max(0, limit - current);
  return `目标 cgroup v${cgroup.version}：${formatBytes(current)} / ${formatBytes(limit)}`
    + `（${(current / limit * 100).toFixed(1)}%，剩余 ${formatBytes(remaining)}）`;
}

/**
 * fork-pyheap 的峰值取决于对象数量与引用图；cgroup 数值用于展示风险和规划 Headroom，不阻断采集。
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
