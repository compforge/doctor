import { describe, expect, test } from "bun:test";
import {
  applyHeapDumpHeadroomPlanCmd,
  HEADROOM_TARGET_RSS_MULTIPLIER,
  resolveHeapDumpHeadroom,
} from "../src/collect/memory/heap-dump-headroom";
import {
  resumeUvicornSupervisorCmd,
  type UvicornSupervisorGuard,
} from "../src/collect/memory/uvicorn-guard";
import type { ProcScan } from "../src/collect/fact/process";

const MIB = 1024 ** 2;

function scan(): ProcScan {
  return {
    rows: [
      { pid: 8, comm: "python", rssMb: 2400, threads: 16, fds: 20 },
      { pid: 9, comm: "python", rssMb: 2300, threads: 16, fds: 20 },
      { pid: 10, comm: "python", rssMb: 1700, threads: 16, fds: 20 },
      { pid: 11, comm: "python", rssMb: 350, threads: 16, fds: 20 },
    ],
    pythonPids: [8, 9, 10, 11],
    workers: [8, 9, 10, 11],
    uvicorn: { mode: "multiprocess", supervisorPid: 7, workerPids: [8, 9, 10, 11] },
  };
}

function cgroup(remainingMb: number) {
  const limitBytes = 8 * 1024 ** 3;
  return {
    version: 2 as const,
    currentBytes: String(limitBytes - remainingMb * MIB),
    limitBytes: String(limitBytes),
    events: {},
  };
}

describe("heap dump Headroom", () => {
  test("skips when cgroup already has twice the target worker RSS", () => {
    const resolution = resolveHeapDumpHeadroom(
      scan(),
      8,
      cgroup(2400 * HEADROOM_TARGET_RSS_MULTIPLIER),
    );
    expect(resolution.plan).toBeUndefined();
    expect(resolution.reason).toContain("无需准备 Headroom");
  });

  test("keeps the smallest sibling serving and retires the others", () => {
    const resolution = resolveHeapDumpHeadroom(scan(), 8, cgroup(900));
    expect(resolution.plan).toEqual({
      strategy: "uvicorn-worker-scale-down",
      supervisorPid: 7,
      targetWorkerPid: 8,
      servingWorker: { pid: 11, rssMb: 350 },
      retiredWorkers: [{ pid: 9, rssMb: 2300 }, { pid: 10, rssMb: 1700 }],
      originalWorkerCount: 4,
      estimatedReclaimMb: 4000,
    });
  });

  test("does not scale down an unknown or two-worker topology", () => {
    const twoWorkers = scan();
    twoWorkers.rows = twoWorkers.rows.slice(0, 2);
    twoWorkers.pythonPids = [8, 9];
    twoWorkers.workers = [8, 9];
    twoWorkers.uvicorn = { mode: "multiprocess", supervisorPid: 7, workerPids: [8, 9] };
    expect(resolveHeapDumpHeadroom(twoWorkers, 8, cgroup(900)).plan).toBeUndefined();
    expect(resolveHeapDumpHeadroom(scan(), 8).plan).toBeUndefined();
  });

  test("validates the supervisor lifecycle before retiring workers", () => {
    const guard: UvicornSupervisorGuard = {
      masterPid: 7,
      workerPid: 8,
      masterStartTime: "123",
      watchdogPid: 90,
    };
    const plan = resolveHeapDumpHeadroom(scan(), 8, cgroup(900)).plan!;
    const apply = applyHeapDumpHeadroomPlanCmd(guard, plan);
    expect(apply.at(-3)).toBe("11");
    expect(apply.at(-2)).toBe("9,10");
    expect(apply[2]).toContain("SIGTERM");
    expect(apply[2]).toContain("SIGKILL");

    const resume = resumeUvicornSupervisorCmd(guard, 2, plan.originalWorkerCount);
    expect(resume.at(-1)).toBe("4");
    expect(resume[2]).toContain("worker_pids");
  });
});
