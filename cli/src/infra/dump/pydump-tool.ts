// Collector 持有随堆规模增长的队列和去重索引；目标 Python 进程仅加载有界 C Agent。
// attach 与持有 GIL 仍会暂停业务进程，所以调用方必须先取得用户确认。
export const PYDUMP_VERSION = "0.2.0";

/** Collector、Agent 与 heap 的执行容器落点；仅在用户明确授权时整目录删除。 */
export const PYDUMP_TOOL_DIR = "/tmp/doctor-pydump";
export const PYDUMP_COLLECTOR_PATH = "/opt/doctor/bin/pydump";
export const PYDUMP_LOADER_PATH = "/opt/doctor/bin/pydump-loader";
export const PYDUMP_AGENT_DIR = "/opt/doctor/lib/pydump";

export interface PydumpTargetLibc {
  family: "glibc" | "musl" | "unknown";
  version?: string;
  raw?: string;
}
/** 探测执行容器是否具备运行 dumper 的完整前置。 */
export function pydumpPrereqCmd(
  collectorPath = PYDUMP_COLLECTOR_PATH,
  loaderPath = PYDUMP_LOADER_PATH,
): string[] {
  // 输出固定 key=value 行，避免 PATH 差异下解析歧义。
  return [
    "sh",
    "-c",
    `python="$(command -v python3 || true)"; `
    + `if { [ -d ${PYDUMP_TOOL_DIR} ] && [ -w ${PYDUMP_TOOL_DIR} ]; } `
    + `|| { [ ! -e ${PYDUMP_TOOL_DIR} ] && [ -w /tmp ]; }; then writable=yes; else writable=no; fi; `
    + `printf "python3=%s\\nwritable=%s\\ncollector=%s\\nloader=%s\\n" `
    + `"${"$"}{python:-missing}" "$writable" `
    + `"$([ -x ${collectorPath} ] && echo ${collectorPath} || echo missing)" `
    + `"$([ -x ${loaderPath} ] && echo ${loaderPath} || echo missing)"`,
  ];
}

export interface PydumpPrereqs {
  python3: boolean;
  writable: boolean;
  collector: boolean;
  loader: boolean;
}

export type PydumpLoaderKind = "gdb" | "ptrace";

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
  const writable = entries.get("writable");
  const collector = entries.get("collector");
  const loader = entries.get("loader");
  if (
    python3 === undefined
    || writable === undefined
    || collector === undefined
    || loader === undefined
  ) {
    return undefined;
  }
  return {
    python3: python3 !== "missing" && python3 !== "",
    writable: writable === "yes",
    collector: collector !== "missing" && collector !== "",
    loader: loader !== "missing" && loader !== "",
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
major, minor = map(int, version.split(".", 1))
if major != 3 or minor < 10:
    raise SystemExit(f"unsupported target CPython {version}; pydump requires CPython 3.10+")
print(version)
`;

export function targetPythonMinorCmd(pid: number): string[] {
  return ["python3", "-c", TARGET_PYTHON_MINOR_SCRIPT, String(pid)];
}

export function parseTargetPythonMinor(output: string): string | undefined {
  const minor = output.trim().split("\n").at(-1)?.trim();
  const match = /^3\.(\d+)$/.exec(minor ?? "");
  return match && Number(match[1]) >= 10 ? minor : undefined;
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

export function pydumpAgentInventoryCmd(
  pythonMinor: string,
  architecture: string,
): string[] {
  return [
    "sh",
    "-c",
    `for path in ${PYDUMP_AGENT_DIR}/pydump-agent-${pythonMinor}-min-glibc-*-${architecture}.so; do `
      + `[ -r "$path" ] && printf '%s\n' "$path"; done; true`,
  ];
}

export function selectPydumpAgentFromInventory(
  output: string,
  pythonMinor: string,
  architecture: string,
  targetGlibcVersion: string,
): { path: string; minimumGlibcVersion: string } | undefined {
  return output
    .split("\n")
    .map((path) => path.trim())
    .flatMap((path) => {
      const match = /pydump-agent-(3\.\d+)-min-glibc-(\d+(?:\.\d+)+)-([A-Za-z0-9_]+)\.so$/.exec(path);
      return match?.[1] === pythonMinor && match[3] === architecture
        ? [{ path, minimumGlibcVersion: match[2]! }]
        : [];
    })
    .filter((item) => (
      compareRuntimeVersions(targetGlibcVersion, item.minimumGlibcVersion) ?? -1
    ) >= 0)
    .sort((left, right) => (
      compareRuntimeVersions(right.minimumGlibcVersion, left.minimumGlibcVersion) ?? 0
    ))[0];
}

/**
 * Collector 在执行容器内保留 O(N) 的图遍历状态，Agent 仅在目标进程中保留有界状态。
 */
export function runPydumpDumpCmd(
  pid: number,
  heapFile: string,
  strReprLen: number,
  agentPath: string,
  loaderPath: string,
  loaderKind: PydumpLoaderKind,
  noAttribute = false,
  collectorPath = PYDUMP_COLLECTOR_PATH,
): string[] {
  return [
    "sh",
    "-c",
    `mkdir -p ${PYDUMP_TOOL_DIR} && TMPDIR=${PYDUMP_TOOL_DIR} `
    + `${collectorPath} --pid ${pid} --file ${heapFile} --agent ${agentPath} `
    + `--loader ${loaderKind} --pydump-loader ${loaderPath} --str-repr-len ${strReprLen}`
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
