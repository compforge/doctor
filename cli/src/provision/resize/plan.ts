import { posix } from "node:path";
import { parseKubernetesBytes } from "../../infra/k8s/resource-quantity";
import type { MemoryHierarchy, MemoryLimitChange, MemoryResizeTarget } from "../../infra/target/memory-resize";
import type { ResizeCliOpts } from "./model";
import { isInteractive } from "../../terminal/policy";

const HEADROOM_BYTES = 256n * 1024n * 1024n;

export function parseResizeMemory(value: string): string {
  const bytes = parseKubernetesBytes(value);
  if (!bytes || !Number.isSafeInteger(bytes) || bytes % (1024 * 1024) !== 0) {
    throw new Error("--memory 必须是正整数 MiB 的内存量，例如 512Mi、1.5Gi 或 8Gi");
  }
  return String(bytes);
}

export function validateResizeOptions(opts: ResizeCliOpts): void {
  if (opts.memory) parseResizeMemory(opts.memory);
  if (!isInteractive(opts.interactive)) {
    const missing = [!opts.pod?.trim() && "--pod <pod>", !opts.memory && "--memory <size>"].filter(Boolean);
    if (missing.length) throw new Error(`非交互调用请指定 ${missing.join(" 和 ")}；多容器 Pod 还必须指定 --container <name>`);
  }
}

function validateHierarchy(target: MemoryResizeTarget, hierarchy: MemoryHierarchy): void {
  let expected = target.cgroupPath;
  for (const group of hierarchy.groups) {
    if (group.path !== expected) throw new Error("cgroup 层级与目标实例不匹配");
    expected = posix.dirname(expected);
  }
  if (hierarchy.groups.at(-1)?.path !== "/" || hierarchy.groups[1]?.path !== target.podCgroupPath) {
    throw new Error("cgroup 父级证据不完整");
  }
}

export function effectiveMemoryLimit(hierarchy: MemoryHierarchy): string {
  return String(hierarchy.groups.reduce((min, group) => {
    const limit = BigInt(group.limitBytes);
    return limit < min ? limit : min;
  }, BigInt(hierarchy.groups[0]!.limitBytes)));
}

/**
 * @spec Only the selected Pod and container may grow; other ancestor ceilings are never bypassed.
 * @see cli/docs/commands/resize.md
 */
export function planMemoryGrowth(target: MemoryResizeTarget, hierarchy: MemoryHierarchy, requestedBytes: string): MemoryLimitChange[] {
  validateHierarchy(target, hierarchy);
  const requested = BigInt(requestedBytes);
  const leaf = hierarchy.groups[0]!;
  if (requested < BigInt(leaf.limitBytes)) throw new Error("--memory 仅支持上调，不能降低现有内存上限");
  const pod = hierarchy.groups[1]!;
  const podLimit = BigInt(pod.limitBytes);
  // Preserve the Pod's existing budget for siblings and slack as the selected container grows.
  // Limits beyond the CLI's representable range already cover every supported target size.
  const podGrowth = podLimit <= BigInt(Number.MAX_SAFE_INTEGER) ? requested - BigInt(leaf.limitBytes) : 0n;
  const podDesired = podLimit + podGrowth > requested ? podLimit + podGrowth : requested;
  const changes = [
    { group: pod, desired: podDesired },
    { group: leaf, desired: requested },
  ].filter(({ group, desired }) => BigInt(group.limitBytes) < desired)
    .map(({ group, desired }) => ({ path: group.path, inode: group.inode, beforeBytes: group.limitBytes, afterBytes: String(desired) }));
  const ancestorRequired = changes.some(change => change.path === pod.path) ? podDesired : requested;
  for (const [index, group] of hierarchy.groups.entries()) {
    const desired = index === 0 ? requested : index === 1 ? podDesired : ancestorRequired;
    if (group.memswLimitBytes && BigInt(group.memswLimitBytes) < desired) {
      throw new Error(`memory+swap 限制不足：${group.path}；本命令不会调整 memsw 限制`);
    }
  }
  const growth = requested - BigInt(effectiveMemoryLimit(hierarchy));
  if (changes.length && BigInt(hierarchy.nodeAvailableBytes) < growth + HEADROOM_BYTES) {
    throw new Error("节点可用内存不足以覆盖新增额度并保留 256 MiB 余量");
  }
  for (const group of hierarchy.groups.slice(2)) {
    if (BigInt(group.limitBytes) < ancestorRequired
      || (changes.length && BigInt(group.limitBytes) < BigInt(group.usageBytes) + growth + HEADROOM_BYTES)) {
      throw new Error(`上层 cgroup 容量不足：${group.path}；停止调整`);
    }
  }
  return changes;
}

