// PyHeap dumper 既可来自 doctor debug image，也可由 doctor CLI 临时上传到已经具备
// Python、GDB Python scripting、ptrace 与可写临时目录的目标容器。
//
// dumper 经 GDB attach 后向目标解释器注入 dump 代码——对象遍历与 dump 写入发生在
// 业务进程内（此期间持有 GIL），这是 debugger-attach 级副作用，调用方必须先取得用户确认。
export const PYHEAP_VERSION = "0.7.0+doctor.2";

/** dumper、PEX/analyzer cache 与 heap/JSON 的执行容器落点；仅在用户明确授权时整目录删除。 */
export const PYHEAP_TOOL_DIR = "/tmp/doctor-pyheap";
export const PYHEAP_DUMP_PEX_PATH = "/opt/doctor/bin/pyheap_dump";
export const PYHEAP_ANALYZER_PEX_PATH = "/opt/doctor/bin/pyheap_analyzer";

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

master_pid, expected_start_time, watchdog_pid, settle_seconds = (
    int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
)
fields = open(f"/proc/{master_pid}/stat").read().rsplit(")", 1)[1].split()
if fields[19] != expected_start_time:
    raise SystemExit(f"Uvicorn master pid={master_pid} 已发生复用，拒绝发送 SIGCONT")

# GDB detach 后先让 worker 的 pong 线程恢复，再唤醒可能停在 health-check 中的 master。
time.sleep(settle_seconds)
os.kill(master_pid, signal.SIGCONT)
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
): string[] {
  return [
    "python3",
    "-c",
    RESUME_UVICORN_SUPERVISOR_SCRIPT,
    String(guard.masterPid),
    guard.masterStartTime,
    String(guard.watchdogPid),
    String(settleSeconds),
  ];
}

/** 探测执行容器是否具备运行 dumper 的完整前置。 */
export function pyheapPrereqCmd(dumpPath = PYHEAP_DUMP_PEX_PATH): string[] {
  // 输出固定 key=value 行，避免 PATH 差异下解析歧义。
  return [
    "sh",
    "-c",
    `python="$(command -v python3 || true)"; gdb="$(command -v gdb || true)"; `
    + `if [ -n "$gdb" ] && "$gdb" -nx -batch -ex 'python import sys' -ex quit >/dev/null 2>&1; then gdb_python=yes; else gdb_python=no; fi; `
    + `if { [ -d ${PYHEAP_TOOL_DIR} ] && [ -w ${PYHEAP_TOOL_DIR} ]; } `
    + `|| { [ ! -e ${PYHEAP_TOOL_DIR} ] && [ -w /tmp ]; }; then writable=yes; else writable=no; fi; `
    + `printf "python3=%s\\ngdb=%s\\ngdb_python=%s\\nwritable=%s\\npyheap=%s\\n" `
    + `"${"$"}{python:-missing}" "${"$"}{gdb:-missing}" "$gdb_python" "$writable" `
    + `"$([ -x ${dumpPath} ] && echo ${dumpPath} || echo missing)"`,
  ];
}

export interface PyheapPrereqs {
  python3: boolean;
  gdb: boolean;
  gdbPython: boolean;
  writable: boolean;
  pyheap: boolean;
}

export function parsePyheapPrereqs(output: string): PyheapPrereqs | undefined {
  const entries = new Map(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)] as const;
      }),
  );
  const python3 = entries.get("python3");
  const gdb = entries.get("gdb");
  const gdbPython = entries.get("gdb_python");
  const writable = entries.get("writable");
  const pyheap = entries.get("pyheap");
  if (
    python3 === undefined
    || gdb === undefined
    || gdbPython === undefined
    || writable === undefined
    || pyheap === undefined
  ) {
    return undefined;
  }
  return {
    python3: python3 !== "missing" && python3 !== "",
    gdb: gdb !== "missing" && gdb !== "",
    gdbPython: gdbPython === "yes",
    writable: writable === "yes",
    pyheap: pyheap !== "missing" && pyheap !== "",
  };
}

/**
 * 在目标容器内执行 heap dump。PEX_ROOT 必须指向可写目录：PEX 启动时自解压到该处，
 * 容器内 HOME 常不可写，缺省值会直接 bootstrap 失败。
 */
export function runPyheapDumpCmd(
  pid: number,
  heapFile: string,
  strReprLen: number,
  noAttribute = false,
  dumpPath = PYHEAP_DUMP_PEX_PATH,
): string[] {
  return [
    "sh",
    "-c",
    `mkdir -p ${PYHEAP_TOOL_DIR} && PEX_ROOT=${PYHEAP_TOOL_DIR}/pex TMPDIR=${PYHEAP_TOOL_DIR} `
    + `python3 ${dumpPath} --pid ${pid} --file ${heapFile} --str-repr-len ${strReprLen}`
    + (noAttribute ? " --no-attribute" : ""),
  ];
}

/** dump 完成且目标进程恢复后，在 debug container 内生成低内存占用的 summary JSON。 */
export function runPyheapSummaryCmd(
  heapFile: string,
  analysisFile: string,
): string[] {
  return [
    "sh",
    "-c",
    `PEX_ROOT=${PYHEAP_TOOL_DIR}/pex PYHEAP_CACHE_DIR=${PYHEAP_TOOL_DIR}/cache `
    + `python3 ${PYHEAP_ANALYZER_PEX_PATH} summary --file ${heapFile} > ${analysisFile}`,
  ];
}

/** heap 与 analyzer 都已回传本机后，执行完整 retained-heap 分析。 */
export function localPyheapRetainedArgv(
  analyzerFile: string,
  heapFile: string,
  topN = 100,
): string[] {
  return [
    "python3",
    analyzerFile,
    "retained-heap",
    "--file",
    heapFile,
    "--top-n",
    String(topN),
    "--format",
    "json",
  ];
}

const FILE_METADATA_SCRIPT = String.raw`
import hashlib
import os
import sys

path = sys.argv[1]
digest = hashlib.sha256()
with open(path, "rb") as f:
    while chunk := f.read(1 << 20):
        digest.update(chunk)
print(os.path.getsize(path), digest.hexdigest())
`;

export function fileMetadataCmd(path: string): string[] {
  return ["python3", "-c", FILE_METADATA_SCRIPT, path];
}

export interface FileMetadata {
  bytes: number;
  sha256: string;
}

export function parseFileMetadata(output: string): FileMetadata | undefined {
  const match = output.trim().match(/^(\d+)\s+([a-f0-9]{64})$/);
  if (!match) return undefined;
  const bytes = Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
  return { bytes, sha256: match[2] };
}

const COMPRESS_FILE_SCRIPT = String.raw`
import hashlib
import os
import sys
import zlib

src, dst = sys.argv[1], sys.argv[2]
compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
digest = hashlib.sha256()
with open(src, "rb") as fin, open(dst, "wb") as fout:
    while True:
        chunk = fin.read(1 << 20)
        if not chunk:
            break
        compressed = compressor.compress(chunk)
        fout.write(compressed)
        digest.update(compressed)
    compressed = compressor.flush()
    fout.write(compressed)
    digest.update(compressed)
print(os.path.getsize(dst), digest.hexdigest())
`;

export function compressFileCmd(src: string, dst: string): string[] {
  return ["python3", "-c", COMPRESS_FILE_SCRIPT, src, dst];
}

export function cleanupPyheapCmd(): string[] {
  return ["sh", "-c", `rm -rf ${PYHEAP_TOOL_DIR}`];
}
