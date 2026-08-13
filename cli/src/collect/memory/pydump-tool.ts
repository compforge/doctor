// Collector 持有随堆规模增长的队列和去重索引；目标 Python 进程仅加载有界 C Agent。
// attach 与持有 GIL 仍会暂停业务进程，所以调用方必须先取得用户确认。
export const PYDUMP_VERSION = "0.1.0";

/** Collector、Agent 与 heap 的执行容器落点；仅在用户明确授权时整目录删除。 */
export const PYDUMP_TOOL_DIR = "/tmp/doctor-pydump";
export const PYDUMP_COLLECTOR_PATH = "/opt/doctor/bin/pydump";
export const PYDUMP_AGENT_DIR = "/opt/doctor/lib/pydump";
export const PYDUMP_AGENT_MIN_GLIBC_VERSIONS = ["2.17"] as const;

export interface PydumpTargetLibc {
  family: "glibc" | "musl" | "unknown";
  version?: string;
  raw?: string;
}

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
export function pydumpPrereqCmd(collectorPath = PYDUMP_COLLECTOR_PATH): string[] {
  // 输出固定 key=value 行，避免 PATH 差异下解析歧义。
  return [
    "sh",
    "-c",
    `python="$(command -v python3 || true)"; gdb="$(command -v gdb || true)"; `
    + `if { [ -d ${PYDUMP_TOOL_DIR} ] && [ -w ${PYDUMP_TOOL_DIR} ]; } `
    + `|| { [ ! -e ${PYDUMP_TOOL_DIR} ] && [ -w /tmp ]; }; then writable=yes; else writable=no; fi; `
    + `printf "python3=%s\\ngdb=%s\\nwritable=%s\\ncollector=%s\\n" `
    + `"${"$"}{python:-missing}" "${"$"}{gdb:-missing}" "$writable" `
    + `"$([ -x ${collectorPath} ] && echo ${collectorPath} || echo missing)"`,
  ];
}

export interface PydumpPrereqs {
  python3: boolean;
  gdb: boolean;
  writable: boolean;
  collector: boolean;
}

export function parsePydumpPrereqs(output: string): PydumpPrereqs | undefined {
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
  const writable = entries.get("writable");
  const collector = entries.get("collector");
  if (
    python3 === undefined
    || gdb === undefined
    || writable === undefined
    || collector === undefined
  ) {
    return undefined;
  }
  return {
    python3: python3 !== "missing" && python3 !== "",
    gdb: gdb !== "missing" && gdb !== "",
    writable: writable === "yes",
    collector: collector !== "missing" && collector !== "",
  };
}

const TARGET_PYTHON_MINOR_SCRIPT = String.raw`
import os
import re
import sys

pid = int(sys.argv[1])
library = re.compile(r"libpython(?P<version>3\.[0-9]+).*\.so(?:\.|$)")
executable = re.compile(r"python(?P<version>3\.[0-9]+)(?:$|[^0-9])")
candidates = [os.readlink(f"/proc/{pid}/exe")]
with open(f"/proc/{pid}/maps", encoding="utf-8") as maps:
    candidates.extend(line.split(maxsplit=5)[-1].strip() for line in maps if "/" in line)
versions = set()
for candidate in candidates:
    match = library.search(candidate) or executable.search(os.path.basename(candidate))
    if match:
        versions.add(match.group("version"))
if len(versions) != 1:
    raise SystemExit("cannot uniquely detect target CPython minor: " + ", ".join(sorted(versions)))
version = versions.pop()
if version not in {"3.10", "3.11", "3.12", "3.13", "3.14"}:
    raise SystemExit(f"unsupported target CPython {version}; pydump supports 3.10-3.14")
print(version)
`;

export function targetPythonMinorCmd(pid: number): string[] {
  return ["python3", "-c", TARGET_PYTHON_MINOR_SCRIPT, String(pid)];
}

export function parseTargetPythonMinor(output: string): string | undefined {
  const minor = output.trim().split("\n").at(-1)?.trim();
  return minor && /^3\.(?:10|11|12|13|14)$/.test(minor) ? minor : undefined;
}

const TARGET_LIBC_SCRIPT = String.raw`
import json
import os
import re
import sys

pid = int(sys.argv[1])
raw = ""
try:
    raw = os.confstr("CS_GNU_LIBC_VERSION") or ""
except (OSError, ValueError):
    pass
match = re.search(r"\bglibc\s+([0-9]+(?:\.[0-9]+)+)", raw, re.IGNORECASE)
if match:
    result = {"family": "glibc", "version": match.group(1), "raw": raw}
else:
    with open(f"/proc/{pid}/maps", encoding="utf-8") as maps:
        mapped = maps.read().lower()
    family = "musl" if "musl" in mapped else "unknown"
    result = {"family": family, "raw": raw or None}
print(json.dumps(result, separators=(",", ":")))
`;

/** Probe the libc actually used by the target Python binary, inside its own container root. */
export function targetLibcCmd(pid: number): string[] {
  return [
    `/proc/${pid}/exe`,
    "-I",
    "-S",
    "-c",
    TARGET_LIBC_SCRIPT,
    String(pid),
  ];
}

export function parsePydumpTargetLibc(output: string): PydumpTargetLibc | undefined {
  try {
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "") as {
      family?: unknown;
      version?: unknown;
      raw?: unknown;
    };
    if (
      parsed.family !== "glibc"
      && parsed.family !== "musl"
      && parsed.family !== "unknown"
    ) {
      return undefined;
    }
    return {
      family: parsed.family,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      raw: typeof parsed.raw === "string" ? parsed.raw : undefined,
    };
  } catch {
    return undefined;
  }
}

function versionParts(version: string): number[] | undefined {
  const match = /^(\d+(?:\.\d+)+)/.exec(version.trim());
  return match?.[1]?.split(".").map(Number);
}

export function compareRuntimeVersions(left: string, right: string): number | undefined {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return undefined;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Select the newest packaged Agent whose minimum glibc is satisfied by the target. */
export function selectPydumpAgentMinGlibc(targetVersion: string): string | undefined {
  return PYDUMP_AGENT_MIN_GLIBC_VERSIONS
    .filter((minimum) => (compareRuntimeVersions(targetVersion, minimum) ?? -1) >= 0)
    .at(-1);
}

export function pydumpImageAgentPath(
  pythonMinor: string,
  architecture: string,
  minGlibcVersion: string,
): string {
  return `${PYDUMP_AGENT_DIR}/pydump-agent-${pythonMinor}-min-glibc-${minGlibcVersion}-${architecture}.so`;
}

export function pydumpUploadedAgentPath(
  pythonMinor: string,
  architecture: string,
  minGlibcVersion: string,
): string {
  return `${PYDUMP_TOOL_DIR}/pydump-agent-${pythonMinor}-min-glibc-${minGlibcVersion}-${architecture}.so`;
}

/**
 * Collector 在执行容器内保留 O(N) 的图遍历状态，Agent 仅在目标进程中保留有界状态。
 */
export function runPydumpDumpCmd(
  pid: number,
  heapFile: string,
  strReprLen: number,
  agentPath: string,
  noAttribute = false,
  collectorPath = PYDUMP_COLLECTOR_PATH,
): string[] {
  return [
    "sh",
    "-c",
    `mkdir -p ${PYDUMP_TOOL_DIR} && TMPDIR=${PYDUMP_TOOL_DIR} `
    + `${collectorPath} --pid ${pid} --file ${heapFile} --agent ${agentPath} --str-repr-len ${strReprLen}`
    + (noAttribute ? " --no-attribute" : ""),
  ];
}

/** heap 与 analyzer 都已回传本机后，执行完整 retained-heap 分析。 */
export function localPydumpRetainedArgv(
  analyzerFile: string,
  heapFile: string,
  topN = 100,
): string[] {
  return [
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

export function cleanupPydumpCmd(): string[] {
  return ["sh", "-c", `rm -rf ${PYDUMP_TOOL_DIR}`];
}
