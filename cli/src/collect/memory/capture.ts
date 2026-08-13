import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { infra } from "../../infra";
import type { DebugEnvironmentFact } from "../../infra/target/debug";
import type { ExecResult, ExecTarget, Executor } from "../../infra/k8s/executor";
import type { ContainerInfo } from "../../infra/k8s/target";
import { prepareTerminalInput } from "../../terminal/input";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import {
  formatTerminalProgress,
  type TerminalProgressUpdate,
} from "../../terminal/progress";
import { EvidenceBundle, type StepRisk } from "../evidence";
import { failReason } from "../../infra/k8s/result";
import { parseProcscan, pickPid, PROCESS_SCAN_SOURCE, processScanCmd } from "../fact/process";
import { parsePtraceFacts, podDeclaresSysPtrace, ptraceFactsCmd } from "../fact/ptrace";
import {
  cgroupMemoryCmd,
  cgroupOomKillCount,
  parseCgroupMemoryFacts,
  type CgroupMemoryFacts,
} from "../fact/cgroup-memory";
import { MEMORY_CAPTURE_SCHEMA, type MemoryCaptureArtifact } from "./capture-artifact";
import { pydumpMemoryRiskLines } from "./capture-risk";
import { resolveKubernetesPydumpCaptureTools } from "./toolkit-pydump";
import {
  compressFileCmd,
  fileMetadataCmd,
  parseFileMetadata,
  parsePydumpPrereqs,
  parsePydumpTargetLibc,
  parseTargetPythonMinor,
  parseUvicornSupervisorGuard,
  pydumpImageAgentPath,
  pydumpPrereqCmd,
  PYDUMP_TOOL_DIR,
  PYDUMP_COLLECTOR_PATH,
  PYDUMP_VERSION,
  pydumpUploadedAgentPath,
  resumeUvicornSupervisorCmd,
  runPydumpDumpCmd,
  selectPydumpAgentMinGlibc,
  suspendUvicornSupervisorCmd,
  targetLibcCmd,
  targetPythonMinorCmd,
  type PydumpTargetLibc,
  type UvicornSupervisorGuard,
} from "./pydump-tool";
import {
  startTemporaryLivenessProxy,
  stopLivenessProxyCmd,
  type ActiveLivenessProxy,
  type LivenessProxyIntent,
} from "./liveness-proxy";

export type PydumpDetail = "lite" | "full";
export type CapturePreference = "auto" | "debug-container" | "target-container";
export type CaptureStrategy = Exclude<CapturePreference, "auto">;

const TARGET_COLLECTOR_PATH = `${PYDUMP_TOOL_DIR}/pydump`;
const DUMP_TIMEOUT_MS = 15 * 60_000;
const SUPERVISOR_AUTO_RESUME_SECONDS = DUMP_TIMEOUT_MS / 1000 + 60;
const MAX_FETCH_RAW_BYTES = 2 * 1024 * 1024 * 1024;

function timestamp(date: Date): string {
  return date.toISOString().replaceAll(/[:-]/g, "").replace("T", "-").slice(0, 15);
}

export function parsePydumpDetail(value: string | undefined): PydumpDetail {
  const normalized = value?.trim().toLowerCase() || "lite";
  if (normalized === "lite" || normalized === "full") return normalized;
  throw new Error(`--detail 仅支持 lite 或 full: '${value}'`);
}

export function parseCapturePreference(value: string | undefined): CapturePreference {
  const normalized = value?.trim().toLowerCase() || "auto";
  if (
    normalized === "auto"
    || normalized === "debug-container"
    || normalized === "target-container"
  ) return normalized;
  throw new Error(
    `--capture-via 仅支持 auto、debug-container 或 target-container: '${value}'`,
  );
}

export function parseStrReprLen(value: string | undefined, defaultValue = -1): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < -1) {
    throw new Error(`--str-repr-len 需要 >= -1 的整数（-1 表示不采集字符串表示）: '${raw}'`);
  }
  return parsed;
}

export function parseTransferChunkBytes(value: string | undefined): number {
  const normalized = value?.trim().toLowerCase() || "2m";
  if (normalized === "1m") return 1024 * 1024;
  if (normalized === "2m") return 2 * 1024 * 1024;
  if (normalized === "4m") return 4 * 1024 * 1024;
  throw new Error(`--transfer-chunk-size 仅支持 1m、2m 或 4m: '${value}'`);
}

export function defaultMemoryHeapPath(pod: string, pid: number, invokedAt: Date): string {
  return `doctor-mem-${pod}-pid${pid}-${timestamp(invokedAt)}.pyheap`;
}

export function resolveMemoryCapturePaths(
  output: string | undefined,
  pod: string,
  pid: number,
  invokedAt: Date,
): { heapPath: string; capturePath: string } {
  const requested = output?.trim();
  const heapPath = !requested
    ? defaultMemoryHeapPath(pod, pid, invokedAt)
    : /\.pyheap$/i.test(requested)
      ? requested
      : `${requested}.pyheap`;
  return {
    heapPath: resolve(heapPath),
    capturePath: resolve(heapPath.replace(/\.pyheap$/i, ".json")),
  };
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function gunzipArtifact(
  compressedPath: string,
  outputPath: string,
): Promise<{ bytes: number; sha256: string }> {
  let bytes = 0;
  const digest = createHash("sha256");
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(compressedPath),
    createGunzip(),
    inspect,
    createWriteStream(outputPath, { mode: 0o600 }),
  );
  return { bytes, sha256: digest.digest("hex") };
}

function recordStep(
  bundle: EvidenceBundle,
  id: string,
  title: string,
  result: ExecResult,
  risk: StepRisk = "observe",
): void {
  bundle.addStep({
    id,
    title,
    risk,
    status: result.ok ? "ok" : "failed",
    reason: result.ok ? undefined : failReason(result),
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.stdout,
    stderr: result.stderr,
  });
}

export function pydumpDumpFailureReason(result: ExecResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => /Program terminated with signal SIGKILL/i.test(line))) {
    return "目标进程在 dump 期间被 SIGKILL";
  }
  const gdbError = lines
    .slice()
    .reverse()
    .find((line) => line.includes("gdb.error:"))
    ?.split("gdb.error:", 2)[1]
    ?.trim();
  if (gdbError) {
    return /Couldn't write extended state status/i.test(gdbError)
      ? `GDB 无法调用目标进程函数：${gdbError}`
      : `GDB 执行失败：${gdbError}`;
  }
  const specificError = lines.slice().reverse().find(
    (line) => !line.toLowerCase().startsWith("warning:")
      && /\b(error|failed|failure|exception)\b/i.test(line)
      && line !== "Dumping finished with error",
  );
  return specificError ?? failReason(result);
}

export function confirmedRemoteHeapPath(
  path: string,
  metadataResult: ExecResult,
): string | undefined {
  return metadataResult.ok && parseFileMetadata(metadataResult.stdout) ? path : undefined;
}

function prereqDeficiencies(prereqs: ReturnType<typeof parsePydumpPrereqs>): string[] {
  if (!prereqs) return ["前置探测输出无法解析"];
  const missing: string[] = [];
  if (!prereqs.python3) missing.push("python3");
  if (!prereqs.gdb) missing.push("gdb");
  if (!prereqs.writable) missing.push(`可写目录 ${PYDUMP_TOOL_DIR}`);
  return missing;
}

async function verifyGdbReadiness(input: {
  executor: Executor;
  target: { pod: string; container: string };
  bundle: EvidenceBundle;
  stepId: string;
  title: string;
}): Promise<string | undefined> {
  const gdb = await infra.target.debugEngine.inspectGdb(
    input.executor,
    input.target.pod,
    input.target.container,
  );
  const ready = gdb.available && gdb.inferiorCall;
  input.bundle.addStep({
    id: input.stepId,
    title: input.title,
    risk: "observe",
    status: ready ? "ok" : "failed",
    reason: ready ? undefined : gdb.reason ?? "Pydump 所需 GDB 能力验收未通过",
    output: `${JSON.stringify(gdb, null, 2)}\n`,
  });
  if (ready) return undefined;
  return `GDB ${gdb.version ?? "version unknown"} 不满足 Pydump attach 前置：`
    + `${gdb.reason ?? "inferior call 验收未通过"}`;
}

interface CaptureExecution {
  strategy: CaptureStrategy;
  target: ExecTarget;
  container: string;
  label: string;
  collectorPath: string;
}

async function verifyPtrace(input: {
  executor: Executor;
  execution: CaptureExecution;
  pid: number;
  podJson: string;
  bundle: EvidenceBundle;
}): Promise<string | undefined> {
  const result = await input.executor.exec(
    input.execution.target,
    ptraceFactsCmd(input.pid),
    { timeoutMs: 10_000 },
  );
  recordStep(input.bundle, "mem-ptrace", "确认 ptrace attach 能力", result);
  if (!result.ok) return `ptrace 探测失败：${failReason(result)}`;
  try {
    const facts = parsePtraceFacts(
      result.stdout,
      podDeclaresSysPtrace(input.podJson, input.execution.container),
    );
    return facts.attachLikely ? undefined : facts.reason;
  } catch (error) {
    return `ptrace 探测输出无法解析：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function prepareDebugExecution(input: {
  executor: Executor;
  pod: string;
  podJson: string;
  pid: number;
  debug: DebugEnvironmentFact;
  bundle: EvidenceBundle;
}): Promise<{ execution?: CaptureExecution; reason?: string }> {
  const target = { pod: input.pod, container: input.debug.executionContainer };
  const prereqResult = await input.executor.exec(target, pydumpPrereqCmd(), { timeoutMs: 20_000 });
  recordStep(input.bundle, "mem-debug-prereq", "确认 debug container 的 Pydump 前置", prereqResult);
  const prereqs = prereqResult.ok ? parsePydumpPrereqs(prereqResult.stdout) : undefined;
  const missing = prereqDeficiencies(prereqs);
  if (missing.length) {
    return {
      reason: `debug environment ${input.debug.executionContainer}（image=${input.debug.image}）缺少：${missing.join("、")}`,
    };
  }
  const gdbReason = await verifyGdbReadiness({
    executor: input.executor,
    target,
    bundle: input.bundle,
    stepId: "mem-debug-gdb",
    title: "验证 debug container 的 GDB attach 能力",
  });
  if (gdbReason) {
    return {
      reason: `debug environment ${input.debug.executionContainer}（image=${input.debug.image}）的 `
        + `${gdbReason}；请更换包含兼容 GDB 的 doctor debug image，`
        + "或对该 debug container 执行 doctor install gdb",
    };
  }
  const execution: CaptureExecution = {
    strategy: "debug-container",
    target,
    container: input.debug.executionContainer,
    label: `${input.pod}/${input.debug.executionContainer}`,
    collectorPath: prereqs?.collector ? PYDUMP_COLLECTOR_PATH : TARGET_COLLECTOR_PATH,
  };
  const ptraceReason = await verifyPtrace({ ...input, execution });
  return ptraceReason ? { reason: `debug container 无法 attach：${ptraceReason}` } : { execution };
}

async function prepareTargetExecution(input: {
  executor: Executor;
  pod: string;
  podJson: string;
  container: ContainerInfo;
  pid: number;
  bundle: EvidenceBundle;
}): Promise<{ execution?: CaptureExecution; reason?: string }> {
  const target = { pod: input.pod, container: input.container.name };
  const prereqResult = await input.executor.exec(
    target,
    pydumpPrereqCmd(TARGET_COLLECTOR_PATH),
    { timeoutMs: 20_000 },
  );
  recordStep(input.bundle, "mem-target-prereq", "确认目标容器的 Pydump attach 前置", prereqResult);
  const prereqs = prereqResult.ok ? parsePydumpPrereqs(prereqResult.stdout) : undefined;
  const missing = prereqDeficiencies(prereqs);
  if (missing.length) {
    return { reason: `目标容器 ${input.container.name} 缺少：${missing.join("、")}` };
  }
  const gdbReason = await verifyGdbReadiness({
    executor: input.executor,
    target,
    bundle: input.bundle,
    stepId: "mem-target-gdb",
    title: "验证目标容器的 GDB attach 能力",
  });
  if (gdbReason) {
    return {
      reason: `目标容器 ${input.container.name} 的 ${gdbReason}；`
        + "请先对该容器执行 doctor install gdb",
    };
  }
  const execution: CaptureExecution = {
    strategy: "target-container",
    target,
    container: input.container.name,
    label: `${input.pod}/${input.container.name}`,
    collectorPath: TARGET_COLLECTOR_PATH,
  };
  const ptraceReason = await verifyPtrace({ ...input, execution });
  if (ptraceReason) return { reason: `目标容器无法 attach：${ptraceReason}` };
  return { execution };
}

interface PydumpRuntimeSelection {
  pythonMinor: string;
  architecture: string;
  targetLibc: PydumpTargetLibc;
  agentMinGlibc: string;
}

async function inspectPydumpRuntime(input: {
  executor: Executor;
  execution: CaptureExecution;
  targetContainer: string;
  pid: number;
  bundle: EvidenceBundle;
}): Promise<PydumpRuntimeSelection | { reason: string }> {
  const libc = await input.executor.exec(
    { pod: input.execution.target.pod, container: input.targetContainer },
    targetLibcCmd(input.pid),
    { timeoutMs: 10_000 },
  );
  recordStep(input.bundle, "mem-target-libc", "识别目标 Python 进程的 libc", libc);
  const targetLibc = libc.ok ? parsePydumpTargetLibc(libc.stdout) : undefined;
  if (!targetLibc) {
    return { reason: `无法识别目标 Python 进程的 libc：${failReason(libc)}` };
  }
  if (targetLibc.family !== "glibc" || !targetLibc.version) {
    return {
      reason: targetLibc.family === "musl"
        ? "目标 Python 使用 musl；Pydump Agent 当前只支持 glibc"
        : `无法确认目标 Python 使用的 glibc 版本：${targetLibc.raw ?? "unknown"}`,
    };
  }
  const agentMinGlibc = selectPydumpAgentMinGlibc(targetLibc.version);
  if (!agentMinGlibc) {
    return {
      reason: `目标 glibc ${targetLibc.version} 低于 Doctor Toolkit 中全部 Pydump Agent 的兼容门槛`,
    };
  }
  const python = await input.executor.exec(
    input.execution.target,
    targetPythonMinorCmd(input.pid),
    { timeoutMs: 10_000 },
  );
  recordStep(input.bundle, "mem-python-minor", "识别目标 CPython minor", python);
  const pythonMinor = python.ok ? parseTargetPythonMinor(python.stdout) : undefined;
  if (!pythonMinor) {
    return { reason: `无法识别目标 CPython minor：${failReason(python)}` };
  }
  const platform = await input.executor.exec(
    input.execution.target,
    ["uname", "-m"],
    { timeoutMs: 10_000 },
  );
  recordStep(input.bundle, "mem-toolkit-platform", "识别 Toolkit 执行平台", platform);
  if (!platform.ok || !platform.stdout.trim()) {
    return { reason: `无法识别 ${input.execution.label} 的 architecture：${failReason(platform)}` };
  }
  const architecture = platform.stdout.trim();
  return { pythonMinor, architecture, targetLibc, agentMinGlibc };
}

async function prepareExecutionTools(input: {
  executor: Executor;
  execution: CaptureExecution;
  runtime: PydumpRuntimeSelection;
  bundle: EvidenceBundle;
}): Promise<{ collectorPath: string; agentPath: string } | { reason: string }> {
  const { pythonMinor, architecture, agentMinGlibc } = input.runtime;
  const imageAgentPath = pydumpImageAgentPath(
    pythonMinor,
    architecture,
    agentMinGlibc,
  );
  const bundledAgent = await input.executor.exec(
    input.execution.target,
    ["test", "-r", imageAgentPath],
    { timeoutMs: 10_000 },
  );
  const needCollector = input.execution.collectorPath === TARGET_COLLECTOR_PATH;
  const needAgent = !bundledAgent.ok;
  if (!needCollector && !needAgent) {
    return { collectorPath: input.execution.collectorPath, agentPath: imageAgentPath };
  }

  let tools: ReturnType<typeof resolveKubernetesPydumpCaptureTools>;
  try {
    tools = resolveKubernetesPydumpCaptureTools({
      pod: input.execution.target.pod,
      container: input.execution.container,
      architecture,
      pythonMinor,
      minGlibcVersion: agentMinGlibc,
    });
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  if (needCollector) {
    const upload = await infra.fileTransfer.uploadToTarget({
      executor: input.executor,
      target: input.execution.target,
      hostPath: tools.collector,
      targetPath: TARGET_COLLECTOR_PATH,
    });
    recordStep(input.bundle, "mem-upload-collector", "临时上传 Pydump Collector", upload, "overhead");
    if (!upload.ok) return { reason: `Pydump Collector 上传失败：${failReason(upload)}` };
  }
  const agentPath = needAgent
    ? pydumpUploadedAgentPath(pythonMinor, architecture, agentMinGlibc)
    : imageAgentPath;
  if (needAgent) {
    const upload = await infra.fileTransfer.uploadToTarget({
      executor: input.executor,
      target: input.execution.target,
      hostPath: tools.agent,
      targetPath: agentPath,
    });
    recordStep(
      input.bundle,
      "mem-upload-agent",
      `临时上传 CPython ${pythonMinor} / 最低 glibc ${agentMinGlibc} Agent`,
      upload,
      "overhead",
    );
    if (!upload.ok) return { reason: `Pydump Agent 上传失败：${failReason(upload)}` };
  }
  const collectorPath = needCollector ? TARGET_COLLECTOR_PATH : input.execution.collectorPath;
  const verify = await input.executor.exec(
    input.execution.target,
    ["sh", "-c", `test -x ${collectorPath} && test -r ${agentPath}`],
    { timeoutMs: 10_000 },
  );
  recordStep(input.bundle, "mem-pydump-tools", "确认 Pydump Collector 与 Agent", verify);
  return verify.ok
    ? { collectorPath, agentPath }
    : { reason: "Pydump Collector 或 Agent 上传后不可用" };
}

export interface HeapCaptureConfirmation {
  target: string;
  pid: number;
  strategy: CaptureStrategy;
  strReprLen: number;
}

export async function confirmHeapCapture(input: HeapCaptureConfirmation): Promise<boolean> {
  terminalStdout.warning("\n[collect] 即将 attach Python 进程并采集对象堆\n");
  terminalStdout.write(`[collect] 目标：${input.target}，pid=${input.pid}\n`);
  terminalStdout.write(
    `[collect] 执行位置：${input.strategy === "debug-container" ? "已有 debug container" : "目标业务容器"}\n`,
  );
  terminalStdout.write("[collect] - attach 期间 Python 进程会暂停，通常数秒，大堆可能持续数分钟\n");
  terminalStdout.write("[collect] - 暂停期间请求可能超时；异常中断也可能影响目标进程稳定性\n");
  terminalStdout.write("[collect] - 完成后会把 .pyheap 文件传回 Doctor 本机\n");
  if (input.strReprLen !== -1) {
    terminalStdout.write("[collect] - heap 会包含对象字符串表示，可能带入业务数据\n");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    terminalStderr.warning(
      "[collect] 当前为非交互终端，无法取得 attach 确认；已停止（可用 -y/--yes 预先确认）\n",
    );
    return false;
  }
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return ["y", "yes"].includes((await readline.question("继续？[y/N] ")).trim().toLowerCase());
  } catch {
    return false;
  } finally {
    readline.close();
  }
}

interface CaptureParams {
  namespace: string;
  pod: string;
  podUid?: string;
  podJson: string;
  container: ContainerInfo;
  pidFlag?: string;
  detail: PydumpDetail;
  strReprLen: number;
  preference: CapturePreference;
  transferChunkBytes: number;
  output?: string;
  invokedAt: Date;
  confirmed: boolean;
  cgroupMemory?: CgroupMemoryFacts;
  livenessProxyIntent?: LivenessProxyIntent;
}

export interface CaptureResult {
  code: number;
  pid?: number;
  heapPath?: string;
  capturePath?: string;
  remoteHeapPath?: string;
  strategy?: CaptureStrategy;
  reason?: string;
  reasons?: string[];
}

export async function captureMemoryHeap(
  executor: Executor,
  params: CaptureParams,
  ctx: {
    bundle: EvidenceBundle;
    progress?: (update: TerminalProgressUpdate) => void;
    confirm?: typeof confirmHeapCapture;
  },
  log: (line: string) => void,
): Promise<CaptureResult> {
  const execTarget = { pod: params.pod, container: params.container.name };
  const scanResult = await executor.exec(execTarget, processScanCmd(), {
    stdin: PROCESS_SCAN_SOURCE,
    timeoutMs: 60_000,
  });
  recordStep(ctx.bundle, "mem-process-scan", "扫描 Python 进程", scanResult);
  if (!scanResult.ok) {
    return { code: 1, reason: `无法扫描目标容器 Python 进程：${failReason(scanResult)}` };
  }
  const processScan = parseProcscan(scanResult.stdout);
  const picked = pickPid(processScan, params.pidFlag);
  if (!picked.ok) return { code: 1, reason: picked.reason };
  const pid = picked.value;
  if (picked.note) log(`[collect] ${picked.note}`);
  log(`[collect] 目标 Python 进程 pid=${pid}`);

  const debugFacts = infra.target.debugEngine.inspect(params.podJson, params.container.name);
  const debug = debugFacts.selected;
  const rejected: string[] = [];
  let execution: CaptureExecution | undefined;
  if (params.preference !== "target-container" && debug) {
    const prepared = await prepareDebugExecution({
      executor,
      pod: params.pod,
      podJson: params.podJson,
      pid,
      debug,
      bundle: ctx.bundle,
    });
    execution = prepared.execution;
    if (prepared.reason) rejected.push(prepared.reason);
  } else if (params.preference !== "target-container" && !debug) {
    rejected.push(
      `debug container 不可用：${debugFacts.reason ?? "目标 Pod 没有已就绪且兼容的 doctor debug container"}`,
    );
  }

  if (!execution && params.preference !== "debug-container") {
    const prepared = await prepareTargetExecution({
      executor,
      pod: params.pod,
      podJson: params.podJson,
      container: params.container,
      pid,
      bundle: ctx.bundle,
    });
    execution = prepared.execution;
    if (prepared.reason) rejected.push(prepared.reason);
  }
  if (!execution) {
    const reasons = [...rejected, "未执行 attach，也未生成 heap 文件"];
    return {
      code: 1,
      pid,
      reason: reasons.join("；"),
      reasons,
    };
  }
  log(
    `[collect] 采集路径：${execution.strategy === "debug-container" ? "已有 debug container" : "目标容器临时 dumper"}`
    + `（${execution.label}）`,
  );
  for (const line of pydumpMemoryRiskLines({
    cgroupMemory: params.cgroupMemory,
    strategy: execution.strategy,
  })) log(line);

  const runtime = await inspectPydumpRuntime({
    executor,
    execution,
    targetContainer: params.container.name,
    pid,
    bundle: ctx.bundle,
  });
  if ("reason" in runtime) {
    return { code: 1, pid, strategy: execution.strategy, reason: runtime.reason };
  }
  log(
    `[collect] Pydump Agent：CPython ${runtime.pythonMinor} / ${runtime.architecture}，`
    + `目标 glibc ${runtime.targetLibc.version}，匹配最低 glibc ${runtime.agentMinGlibc} 的 Agent`,
  );

  const uvicornSupervisorPid = processScan.uvicorn?.mode === "multiprocess"
    && processScan.uvicorn.workerPids.includes(pid)
    ? processScan.uvicorn.supervisorPid
    : undefined;
  const standaloneUvicornWithLiveness = processScan.uvicorn?.mode === "standalone"
    && processScan.uvicorn.workerPids.includes(pid)
    && params.container.livenessProbe !== undefined;
  if (standaloneUvicornWithLiveness) {
    log(
      `[collect] 警告：单进程 Uvicorn pid=${pid} 同时承载业务与 liveness；`
      + "attach 会暂停健康检查，长时间 dump 可能触发 Container 重启",
    );
  }
  if (uvicornSupervisorPid !== undefined) {
    log(
      `[collect] 检测到 Uvicorn multiprocess：supervisor pid=${uvicornSupervisorPid}，`
      + `目标 worker pid=${pid}；dump 期间会暂停 supervisor，并由 watchdog 兜底恢复`,
    );
  }
  const approved = params.confirmed || await (ctx.confirm ?? confirmHeapCapture)({
    target: `${params.namespace}/${params.pod}/${params.container.name}`,
    pid,
    strategy: execution.strategy,
    strReprLen: params.strReprLen,
  });
  ctx.bundle.addStep({
    id: "mem-attach-confirmation",
    title: "确认 attach Python 进程",
    risk: "disrupt",
    status: approved ? "ok" : "skipped",
    reason: approved ? undefined : "用户未确认",
  });
  if (!approved) return { code: 130, pid, strategy: execution.strategy };

  const preparedTools = await prepareExecutionTools({
    executor,
    execution,
    runtime,
    bundle: ctx.bundle,
  });
  if ("reason" in preparedTools) {
    return { code: 1, pid, strategy: execution.strategy, reason: preparedTools.reason };
  }

  const processStatus = await executor.exec(
    execution.target,
    ["sh", "-c", `cat /proc/${pid}/status; printf '\\nstart_time='; python3 -c 'import sys; print(open(sys.argv[1]).read().rsplit(\")\", 1)[1].split()[19])' /proc/${pid}/stat`],
    { timeoutMs: 10_000 },
  );
  recordStep(ctx.bundle, "mem-process-status", "采集目标进程状态", processStatus);
  const processStartTime = processStatus.stdout.match(/^start_time=(.+)$/m)?.[1]?.trim();

  const heapFile = `${PYDUMP_TOOL_DIR}/heap-${pid}-${params.invokedAt.getTime().toString(36)}.pyheap`;
  let livenessProxy: ActiveLivenessProxy | undefined;
  if (params.livenessProxyIntent) {
    const environments = infra.target.debugEngine.inspectEnvironments(
      params.podJson,
      params.container.name,
    );
    const proxyEnvironment = infra.target.debugEngine.resolveEnvironment(environments, ["NET_ADMIN"]);
    if (!proxyEnvironment.ok) {
      log(
        "[collect] liveness 代理不可用：需要已就绪且显式具备 NET_ADMIN 的 doctor debug container；"
        + "可先执行 doctor debug --capabilities SYS_PTRACE,NET_ADMIN",
      );
    } else {
      const started = await startTemporaryLivenessProxy({
        executor,
        target: { pod: params.pod, container: proxyEnvironment.value.executionContainer },
        intent: params.livenessProxyIntent,
        token: `${pid}-${params.invokedAt.getTime().toString(36)}`,
        ttlSeconds: DUMP_TIMEOUT_MS / 1000 + 60,
      });
      started.results.forEach((result, index) => recordStep(
        ctx.bundle,
        `mem-liveness-proxy-${index + 1}`,
        ["检查 liveness 代理前置", "启动 liveness 代理", "确认 liveness 代理就绪"][index]
          ?? "准备 liveness 代理",
        result,
        "disrupt",
      ));
      livenessProxy = started.proxy;
      if (livenessProxy) {
        log(
          `[collect] 已临时接管 ${params.livenessProxyIntent.service} `
          + `${params.livenessProxyIntent.path} liveness；普通请求继续转发到业务进程`,
        );
      } else {
        log(`[collect] liveness 代理启动失败：${started.reason ?? "原因未知"}；继续执行已确认的 dump`);
      }
    }
  }

  let guard: UvicornSupervisorGuard | undefined;
  let dump: ExecResult;
  let supervisorResumeFailed = false;
  try {
    if (uvicornSupervisorPid !== undefined) {
      const suspend = await executor.exec(
        execution.target,
        suspendUvicornSupervisorCmd(uvicornSupervisorPid, pid, SUPERVISOR_AUTO_RESUME_SECONDS),
        { timeoutMs: 10_000 },
      );
      recordStep(ctx.bundle, "mem-supervisor-suspend", "暂停 Uvicorn supervisor", suspend, "disrupt");
      guard = suspend.ok ? parseUvicornSupervisorGuard(suspend.stdout) : undefined;
      if (!guard) {
        return {
          code: 1,
          pid,
          strategy: execution.strategy,
          reason: `无法安全暂停 Uvicorn supervisor pid=${uvicornSupervisorPid}，未执行 heap dump`,
        };
      }
      log(`[collect] Uvicorn supervisor pid=${uvicornSupervisorPid} 已暂停`);
    }

    log("[collect] 开始 Pydump dump；目标进程现在可能出现卡顿…");
    dump = await executor.exec(
      execution.target,
      runPydumpDumpCmd(
        pid,
        heapFile,
        params.strReprLen,
        preparedTools.agentPath,
        params.detail === "lite",
        preparedTools.collectorPath,
      ),
      {
        timeoutMs: DUMP_TIMEOUT_MS,
        onStdout: (chunk) => {
          for (const line of chunk.split("\n")) if (line.trim()) log(`[pydump] ${line}`);
        },
      },
    );
    recordStep(ctx.bundle, "mem-pydump", "attach 并生成 Pydump 文件", dump, "disrupt");
  } finally {
    if (guard) {
      const resume = await executor.exec(
        execution.target,
        resumeUvicornSupervisorCmd(guard),
        { timeoutMs: 10_000 },
      );
      recordStep(ctx.bundle, "mem-supervisor-resume", "恢复 Uvicorn supervisor", resume, "disrupt");
      if (!resume.ok) {
        supervisorResumeFailed = true;
        log(`[collect] Uvicorn supervisor 恢复未确认；watchdog 会继续尝试恢复`);
      } else {
        log(`[collect] Uvicorn supervisor pid=${guard.masterPid} 已恢复`);
      }
    }
    if (livenessProxy) {
      const stopped = await executor.exec(
        livenessProxy.target,
        stopLivenessProxyCmd(livenessProxy),
        { timeoutMs: 10_000 },
      );
      recordStep(ctx.bundle, "mem-liveness-proxy-stop", "撤销 liveness 代理", stopped, "disrupt");
      if (stopped.ok) {
        log(`[collect] ${livenessProxy.service} liveness 代理已撤销`);
      } else {
        log("[collect] liveness 代理撤销未确认；远端 watchdog 会在超时后清理网络规则");
      }
    }
  }
  if (!dump.ok) {
    const cgroupAfter = await executor.exec(execTarget, cgroupMemoryCmd(), { timeoutMs: 10_000 });
    recordStep(
      ctx.bundle,
      "mem-cgroup-after-failure",
      "heap dump 失败后复查 cgroup 内存事实",
      cgroupAfter,
    );
    const cgroupMemoryAfter = cgroupAfter.ok
      ? parseCgroupMemoryFacts(cgroupAfter.stdout)
      : undefined;
    const sameCgroupVersion = params.cgroupMemory?.version === cgroupMemoryAfter?.version;
    const oomKillsBefore = sameCgroupVersion
      ? cgroupOomKillCount(params.cgroupMemory)
      : undefined;
    const oomKillsAfter = sameCgroupVersion
      ? cgroupOomKillCount(cgroupMemoryAfter)
      : undefined;
    let dumpFailureReason = pydumpDumpFailureReason(dump);
    if (
      oomKillsBefore !== undefined
      && oomKillsAfter !== undefined
      && oomKillsAfter > oomKillsBefore
    ) {
      dumpFailureReason = `目标进程在 dump 期间触发 cgroup OOM kill`
        + `（oom_kill: ${oomKillsBefore} -> ${oomKillsAfter}）`;
    } else if (dumpFailureReason.includes("SIGKILL") && guard) {
      dumpFailureReason += oomKillsBefore !== undefined && oomKillsAfter !== undefined
        ? "；Uvicorn supervisor 已暂停，且 cgroup oom_kill 未增长"
        : "；Uvicorn supervisor 已暂停，但当前 cgroup 未提供可比较的 oom_kill 计数";
    }
    const failedMetadataResult = await executor.exec(
      execution.target,
      fileMetadataCmd(heapFile),
      { timeoutMs: 20_000 },
    );
    recordStep(
      ctx.bundle,
      "mem-failed-heap-metadata",
      "检查失败后是否留下 Pydump 文件",
      failedMetadataResult,
    );
    return {
      code: 1,
      pid,
      strategy: execution.strategy,
      remoteHeapPath: confirmedRemoteHeapPath(heapFile, failedMetadataResult),
      reason: `heap dump 失败：${dumpFailureReason}`,
    };
  }

  const metadataResult = await executor.exec(
    execution.target,
    fileMetadataCmd(heapFile),
    { timeoutMs: 20_000 },
  );
  recordStep(ctx.bundle, "mem-heap-metadata", "确认远端 heap 文件", metadataResult);
  const metadata = metadataResult.ok ? parseFileMetadata(metadataResult.stdout) : undefined;
  if (!metadata) {
    return { code: 1, pid, reason: "无法确认远端 heap 文件" };
  }
  if (supervisorResumeFailed) {
    return {
      code: 1,
      pid,
      strategy: execution.strategy,
      remoteHeapPath: heapFile,
      reason: "heap 已生成，但 Uvicorn supervisor 恢复未确认；远端 watchdog 会继续尝试恢复",
    };
  }
  if (metadata.bytes > MAX_FETCH_RAW_BYTES) {
    return {
      code: 1,
      pid,
      remoteHeapPath: heapFile,
      reason: `heap 为 ${formatMiB(metadata.bytes)}，超过 Doctor 自动回传上限`,
    };
  }

  const compressedFile = `${heapFile}.gz`;
  const compress = await executor.exec(
    execution.target,
    compressFileCmd(heapFile, compressedFile),
    { timeoutMs: DUMP_TIMEOUT_MS },
  );
  recordStep(ctx.bundle, "mem-compress", "压缩 heap 文件", compress, "overhead");
  const compressedMetadata = compress.ok ? parseFileMetadata(compress.stdout) : undefined;
  if (!compressedMetadata) {
    return { code: 1, pid, remoteHeapPath: heapFile, reason: `heap 压缩失败：${failReason(compress)}` };
  }

  const outputs = resolveMemoryCapturePaths(params.output, params.pod, pid, params.invokedAt);
  mkdirSync(dirname(outputs.heapPath), { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "doctor-mem-fetch-"));
  const compressedLocal = join(workDir, "heap.pyheap.gz");
  const heapPart = `${outputs.heapPath}.part-${process.pid}-${Date.now()}`;
  let delivered = false;
  try {
    const fetch = await infra.fileTransfer.downloadFromTarget({
      executor,
      target: execution.target,
      targetPath: compressedFile,
      hostPath: compressedLocal,
      expectedBytes: compressedMetadata.bytes,
      chunkBytes: params.transferChunkBytes,
      onStart: (slices) => log(
        `[collect] 目标进程已恢复，开始回传 heap（压缩后 ${formatMiB(compressedMetadata.bytes)}，${slices} 块）…`,
      ),
      onProgress: ({ slice, totalSlices, fetchedBytes, totalBytes }) => {
        const update = {
          label: "[collect] 回传 heap",
          current: fetchedBytes,
          total: totalBytes,
          detail: `${slice}/${totalSlices} 块`,
          complete: slice === totalSlices,
        };
        if (ctx.progress) ctx.progress(update);
        else log(formatTerminalProgress(update));
      },
      onRetry: (offset, attempt, reason) =>
        log(`[collect] heap 回传异常（offset=${offset}，${reason}），正在第 ${attempt} 次尝试…`),
    });
    if (!fetch.ok) {
      return { code: 1, pid, remoteHeapPath: heapFile, reason: "heap 分片回传失败" };
    }
    if (await sha256File(compressedLocal) !== compressedMetadata.sha256) {
      return { code: 1, pid, remoteHeapPath: heapFile, reason: "回传的 heap.gz sha256 不一致" };
    }
    const artifact = await gunzipArtifact(compressedLocal, heapPart);
    if (artifact.bytes !== metadata.bytes || artifact.sha256 !== metadata.sha256) {
      return { code: 1, pid, remoteHeapPath: heapFile, reason: "解压后的 heap 校验失败" };
    }
    renameSync(heapPart, outputs.heapPath);
    delivered = true;

    const capture: MemoryCaptureArtifact = {
      schema: MEMORY_CAPTURE_SCHEMA,
      captured_at: params.invokedAt.toISOString(),
      pydump_version: PYDUMP_VERSION,
      target: {
        namespace: params.namespace,
        pod: params.pod,
        pod_uid: params.podUid,
        container: params.container.name,
        image: params.container.image,
        image_id: params.container.imageId,
        restart_count: params.container.restartCount,
        pid,
        process_start_time: processStartTime,
      },
      capture: {
        strategy: execution.strategy,
        execution_container: execution.container,
        detail: params.detail,
        str_repr_len: params.strReprLen,
      },
      heap: {
        file: relative(dirname(outputs.capturePath), outputs.heapPath),
        size_bytes: metadata.bytes,
        sha256: metadata.sha256,
      },
      facts: {
        process_scan: processScan,
        cgroup_memory: params.cgroupMemory,
        process_status: processStatus.ok ? processStatus.stdout : undefined,
        target_libc: runtime.targetLibc,
        pydump_agent: {
          python_minor: runtime.pythonMinor,
          architecture: runtime.architecture,
          glibc_min: runtime.agentMinGlibc,
        },
      },
    };
    writeFileSync(outputs.capturePath, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (!delivered) rmSync(heapPart, { force: true });
  }

  return {
    code: 0,
    pid,
    heapPath: outputs.heapPath,
    capturePath: outputs.capturePath,
    remoteHeapPath: heapFile,
    strategy: execution.strategy,
  };
}
