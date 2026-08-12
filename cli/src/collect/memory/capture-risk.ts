import type { CgroupMemoryFacts } from "../fact/cgroup-memory";

const HIGH_CGROUP_MEMORY_RATIO = 0.8;
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

/**
 * PyHeap 的峰值取决于对象数量与引用图，无法仅凭 RSS 精确预测。这里仅用现场余量标记
 * 明显危险的场景，不把启发式判断升级成阻断条件。
 */
export function pyHeapMemoryRiskLines(input: PyHeapMemoryRiskInput): string[] {
  const lines = [
    "[collect] 内存风险：PyHeap 会在目标 Python 进程内创建随对象数增长的索引并写入 heap 文件；"
      + "即使通过 debug container 执行，目标 container 内存和 page cache 仍可能显著上升",
  ];
  const currentBytes = parseByteCount(input.cgroupMemory?.currentBytes);
  const limitBytes = parseByteCount(input.cgroupMemory?.limitBytes);
  const cgroupVersion = input.cgroupMemory?.version;
  const targetRssBytes = input.targetRssMb === undefined
    ? undefined
    : input.targetRssMb * MIB;

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
      + `（${(ratio * 100).toFixed(1)}%，剩余 ${formatBytes(remainingBytes)}）`
      + (targetRssBytes === undefined ? "" : `；目标 worker RSS：${formatBytes(targetRssBytes)}`),
  );

  const reasons: string[] = [];
  if (ratio >= HIGH_CGROUP_MEMORY_RATIO) {
    reasons.push(`cgroup 使用率已达 ${(ratio * 100).toFixed(1)}%`);
  }
  if (targetRssBytes !== undefined && remainingBytes < targetRssBytes) {
    reasons.push(
      `剩余 ${formatBytes(remainingBytes)} 小于目标 worker RSS ${formatBytes(targetRssBytes)}`,
    );
  }
  if (reasons.length > 0) {
    lines.push(
      `[collect] 高风险：${reasons.join("；")}；dump 期间可能触发 cgroup OOM 并 SIGKILL 目标进程`,
    );
  }
  return lines;
}
