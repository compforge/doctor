export interface UvicornSupervisorGuard {
  masterPid: number;
  workerPid: number;
  masterStartTime: string;
  watchdogPid: number;
}

const SUSPEND_UVICORN_SUPERVISOR_SCRIPT = String.raw`
import os
import signal
import subprocess
import sys

master_pid, worker_pid, resume_after = map(int, sys.argv[1:])

def proc_start_time(pid):
    # /proc/<pid>/stat 的 comm 可含空格，必须从最后一个 ')' 后再按字段拆分。
    fields = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    return fields[19]

worker_status = open(f"/proc/{worker_pid}/status").read().splitlines()
worker_ppid = next(int(line.split(":", 1)[1]) for line in worker_status if line.startswith("PPid:"))
if worker_ppid != master_pid:
    raise SystemExit(f"worker pid={worker_pid} 的 PPid={worker_ppid}，不再属于 Uvicorn master pid={master_pid}")

master_start_time = proc_start_time(master_pid)
watchdog_script = r'''
import os
import signal
import sys
import time

pid, expected_start_time, delay = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
time.sleep(delay)
try:
    fields = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    if fields[19] == expected_start_time:
        os.kill(pid, signal.SIGCONT)
except (FileNotFoundError, ProcessLookupError, PermissionError):
    pass
'''
watchdog = subprocess.Popen(
    [sys.executable, "-c", watchdog_script, str(master_pid), master_start_time, str(resume_after)],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    close_fds=True,
    start_new_session=True,
)
try:
    os.kill(master_pid, signal.SIGSTOP)
except BaseException:
    watchdog.terminate()
    raise

print(f"master_pid={master_pid}")
print(f"worker_pid={worker_pid}")
print(f"master_start_time={master_start_time}")
print(f"watchdog_pid={watchdog.pid}")
`;

const RESUME_UVICORN_SUPERVISOR_SCRIPT = String.raw`
import os
import signal
import sys
import time

master_pid, expected_start_time, watchdog_pid, settle_seconds, expected_worker_count = (
    int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5])
)
fields = open(f"/proc/{master_pid}/stat").read().rsplit(")", 1)[1].split()
if fields[19] != expected_start_time:
    raise SystemExit(f"Uvicorn master pid={master_pid} 已发生复用，拒绝发送 SIGCONT")

# Agent dump 结束后先让 worker 的 pong 线程恢复，再唤醒可能停在 health-check 中的 master。
time.sleep(settle_seconds)
os.kill(master_pid, signal.SIGCONT)

def worker_pids():
    result = []
    for value in os.listdir("/proc"):
        if not value.isdigit():
            continue
        try:
            pid = int(value)
            status = open(f"/proc/{pid}/status").read().splitlines()
            ppid = next(int(line.split(":", 1)[1]) for line in status if line.startswith("PPid:"))
            cmdline = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ")
            if (
                ppid == master_pid
                and (b"multiprocessing.spawn" in cmdline or b"spawn_main" in cmdline)
                and b"multiprocessing.resource_tracker" not in cmdline
            ):
                result.append(pid)
        except (FileNotFoundError, ProcessLookupError, PermissionError, StopIteration, ValueError):
            pass
    return result

if expected_worker_count > 0:
    deadline = time.monotonic() + 20
    workers = worker_pids()
    while len(workers) < expected_worker_count and time.monotonic() < deadline:
        time.sleep(0.2)
        workers = worker_pids()
    if len(workers) < expected_worker_count:
        raise SystemExit(
            f"Uvicorn supervisor 已恢复，但 worker 仅恢复到 {len(workers)}/{expected_worker_count}"
        )
    print(f"worker_pids={','.join(map(str, workers))}")
try:
    os.kill(watchdog_pid, signal.SIGTERM)
except ProcessLookupError:
    pass
print(f"master_pid={master_pid} resumed=true")
`;

/** 暂停 Uvicorn master，并启动与 doctor exec 生命周期解耦的超时恢复 watchdog。 */
export function suspendUvicornSupervisorCmd(
  masterPid: number,
  workerPid: number,
  resumeAfterSeconds: number,
): string[] {
  return [
    "python3",
    "-c",
    SUSPEND_UVICORN_SUPERVISOR_SCRIPT,
    String(masterPid),
    String(workerPid),
    String(resumeAfterSeconds),
  ];
}

export function parseUvicornSupervisorGuard(output: string): UvicornSupervisorGuard | undefined {
  const values = new Map(
    output
      .split("\n")
      .map((line) => line.trim().split("=", 2))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key, value] as const),
  );
  const masterPid = Number(values.get("master_pid"));
  const workerPid = Number(values.get("worker_pid"));
  const watchdogPid = Number(values.get("watchdog_pid"));
  const masterStartTime = values.get("master_start_time");
  if (
    !Number.isInteger(masterPid)
    || !Number.isInteger(workerPid)
    || !Number.isInteger(watchdogPid)
    || !masterStartTime
  ) return undefined;
  return { masterPid, workerPid, masterStartTime, watchdogPid };
}

/** 恢复同一生命周期的 Uvicorn master；成功后取消远端 watchdog。 */
export function resumeUvicornSupervisorCmd(
  guard: UvicornSupervisorGuard,
  settleSeconds = 2,
  expectedWorkerCount = 0,
): string[] {
  return [
    "python3",
    "-c",
    RESUME_UVICORN_SUPERVISOR_SCRIPT,
    String(guard.masterPid),
    guard.masterStartTime,
    String(guard.watchdogPid),
    String(settleSeconds),
    String(expectedWorkerCount),
  ];
}
