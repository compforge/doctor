import type { ProcScan } from "../fact/process";
import type { CgroupMemoryFacts } from "../fact/cgroup-memory";
import type { UvicornSupervisorGuard } from "./uvicorn-guard";

const MIB = 1024 ** 2;
export const HEADROOM_TARGET_RSS_MULTIPLIER = 2;

export interface HeapDumpHeadroomProcess {
  pid: number;
  rssMb: number;
}

/** A reversible capacity reduction that creates memory headroom for one heap dump. */
export interface HeapDumpHeadroomPlan {
  strategy: "uvicorn-worker-scale-down";
  supervisorPid: number;
  targetWorkerPid: number;
  servingWorker: HeapDumpHeadroomProcess;
  retiredWorkers: HeapDumpHeadroomProcess[];
  originalWorkerCount: number;
  estimatedReclaimMb: number;
}

export type HeapDumpHeadroomResolution =
  | { plan: HeapDumpHeadroomPlan; reason: string }
  | { plan?: undefined; reason: string };

function byteCount(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Only supervised workers are eligible: Doctor must know who will recreate them after the dump.
 * One sibling always remains available for traffic, so a two-worker process tree has no safe plan.
 */
export function resolveHeapDumpHeadroom(
  scan: ProcScan,
  targetWorkerPid: number,
  cgroupMemory?: CgroupMemoryFacts,
): HeapDumpHeadroomResolution {
  const target = scan.rows.find((row) => row.pid === targetWorkerPid);
  const currentBytes = byteCount(cgroupMemory?.currentBytes);
  const limitBytes = byteCount(cgroupMemory?.limitBytes);
  if (!target || currentBytes === undefined || limitBytes === undefined || limitBytes <= 0) {
    return { reason: "无法确认 cgroup 余量或目标 worker RSS，不主动缩容进程" };
  }
  const remainingBytes = Math.max(0, limitBytes - currentBytes);
  const requiredBytes = target.rssMb * MIB * HEADROOM_TARGET_RSS_MULTIPLIER;
  if (remainingBytes >= requiredBytes) {
    return {
      reason: `cgroup 剩余内存已达到目标 worker RSS 的 ${HEADROOM_TARGET_RSS_MULTIPLIER} 倍，无需准备 Headroom`,
    };
  }

  const topology = scan.uvicorn;
  if (
    topology?.mode !== "multiprocess"
    || !topology.workerPids.includes(targetWorkerPid)
    || topology.workerPids.length < 3
  ) return { reason: "未发现可安全缩容且能由 supervisor 恢复的冗余 worker" };

  const workers = topology.workerPids.map((pid) => {
    const row = scan.rows.find((candidate) => candidate.pid === pid);
    return row ? { pid, rssMb: row.rssMb } : undefined;
  });
  if (workers.some((worker) => worker === undefined)) {
    return { reason: "worker RSS 事实不完整，不主动缩容进程" };
  }

  const siblings = workers
    .filter((worker): worker is HeapDumpHeadroomProcess => (
      worker !== undefined && worker.pid !== targetWorkerPid
    ))
    .sort((left, right) => left.rssMb - right.rssMb || left.pid - right.pid);
  const servingWorker = siblings[0];
  if (!servingWorker || siblings.length < 2) {
    return { reason: "没有可在保留服务 worker 后缩容的冗余 worker" };
  }

  const retiredWorkers = siblings
    .slice(1)
    .sort((left, right) => right.rssMb - left.rssMb || left.pid - right.pid);
  const plan: HeapDumpHeadroomPlan = {
    strategy: "uvicorn-worker-scale-down",
    supervisorPid: topology.supervisorPid,
    targetWorkerPid,
    servingWorker,
    retiredWorkers,
    originalWorkerCount: topology.workerPids.length,
    estimatedReclaimMb: retiredWorkers.reduce((total, worker) => total + worker.rssMb, 0),
  };
  return {
    plan,
    reason: `cgroup 余量低于目标 worker RSS 的 ${HEADROOM_TARGET_RSS_MULTIPLIER} 倍`,
  };
}

const APPLY_HEADROOM_PLAN_SCRIPT = String.raw`
import os
import signal
import sys
import time

master_pid = int(sys.argv[1])
expected_master_start_time = sys.argv[2]
target_pid = int(sys.argv[3])
serving_pid = int(sys.argv[4])
retired_pids = [int(value) for value in sys.argv[5].split(",") if value]
grace_seconds = float(sys.argv[6])

def proc_fields(pid):
    return open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()

def proc_start_time(pid):
    return proc_fields(pid)[19]

def proc_state(pid):
    try:
        return proc_fields(pid)[0]
    except FileNotFoundError:
        return None

def proc_ppid(pid):
    status = open(f"/proc/{pid}/status").read().splitlines()
    return next(int(line.split(":", 1)[1]) for line in status if line.startswith("PPid:"))

if proc_start_time(master_pid) != expected_master_start_time:
    raise SystemExit(f"Uvicorn supervisor pid={master_pid} 已发生复用，拒绝缩容 worker")
if proc_state(master_pid) not in ("T", "t"):
    raise SystemExit(f"Uvicorn supervisor pid={master_pid} 未暂停，拒绝缩容 worker")

all_workers = [target_pid, serving_pid, *retired_pids]
if len(set(all_workers)) != len(all_workers):
    raise SystemExit("headroom plan contains duplicate worker pids")
for pid in all_workers:
    if proc_ppid(pid) != master_pid:
        raise SystemExit(f"worker pid={pid} 不再属于 Uvicorn supervisor pid={master_pid}")

for pid in retired_pids:
    os.kill(pid, signal.SIGTERM)

deadline = time.monotonic() + grace_seconds
remaining = retired_pids[:]
while remaining and time.monotonic() < deadline:
    remaining = [pid for pid in remaining if proc_state(pid) not in (None, "Z")]
    if remaining:
        time.sleep(0.1)

for pid in remaining:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

kill_deadline = time.monotonic() + 5
while remaining and time.monotonic() < kill_deadline:
    remaining = [pid for pid in remaining if proc_state(pid) not in (None, "Z")]
    if remaining:
        time.sleep(0.1)
if remaining:
    raise SystemExit(f"workers did not exit: {','.join(map(str, remaining))}")

print(f"serving_worker_pid={serving_pid}")
print(f"retired_worker_pids={','.join(map(str, retired_pids))}")
`;

export function applyHeapDumpHeadroomPlanCmd(
  guard: UvicornSupervisorGuard,
  plan: HeapDumpHeadroomPlan,
  graceSeconds = 15,
): string[] {
  if (
    guard.masterPid !== plan.supervisorPid
    || guard.workerPid !== plan.targetWorkerPid
  ) throw new Error("Uvicorn supervisor guard 与 heap dump 内存余量计划不匹配");
  return [
    "python3",
    "-c",
    APPLY_HEADROOM_PLAN_SCRIPT,
    String(plan.supervisorPid),
    guard.masterStartTime,
    String(plan.targetWorkerPid),
    String(plan.servingWorker.pid),
    plan.retiredWorkers.map((worker) => worker.pid).join(","),
    String(graceSeconds),
  ];
}
