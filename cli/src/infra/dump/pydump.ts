import { hostTargetFileTransfer } from "../file-transfer";
import { failReason } from "../k8s/result";
import {
  discoverDevelopmentPydumpAgents,
  hostProcessToolkitChannel,
  kubernetesToolkitChannel,
  resolveDevelopmentToolkitTool,
  resolveToolkitBundle,
} from "../toolkit";
import {
  cleanupPydumpCmd,
  compareRuntimeVersions,
  parsePydumpPrereqs,
  parsePydumpTargetLibc,
  parseTargetPythonMinor,
  pydumpAgentInventoryCmd,
  pydumpImageAgentPath,
  pydumpPrereqCmd,
  PYDUMP_COLLECTOR_PATH,
  PYDUMP_LOADER_PATH,
  PYDUMP_TOOL_DIR,
  PYDUMP_VERSION,
  pydumpUploadedAgentPath,
  runPydumpDumpCmd,
  selectPydumpAgentFromInventory,
  targetLibcCmd,
  targetPythonMinorCmd,
  type PydumpTargetLibc,
} from "./pydump-tool";
import type {
  HeapDumpBackend,
  HeapDumpBackendContext,
  HeapDumpBackendResult,
  HeapDumpExecution,
} from "./model";
import type { DebugEnvironmentFact } from "../target/debug";

const TARGET_COLLECTOR_PATH = `${PYDUMP_TOOL_DIR}/pydump`;
const TARGET_LOADER_PATH = `${PYDUMP_TOOL_DIR}/pydump-loader`;

export interface PydumpExecution extends HeapDumpExecution {
  readonly collectorPath: string;
  readonly loaderPath: string;
}

interface PydumpRuntimeBase {
  readonly pythonMinor: string;
  readonly architecture: string;
  readonly targetLibc: PydumpTargetLibc;
}

export type PydumpRuntimeSelection = PydumpRuntimeBase & (
  | {
    readonly source: "execution-image";
    readonly existingAgent: {
      readonly path: string;
      readonly minimumGlibcVersion: string;
    };
  }
  | {
    readonly source: "toolkit";
    readonly tools: KubernetesPydumpCaptureTools;
  }
);

interface ExistingPydumpAgent {
  readonly path: string;
  readonly minimumGlibcVersion: string;
}

export interface PreparedPydumpTools {
  readonly collectorPath: string;
  readonly loaderPath: string;
  readonly agentPath: string;
  readonly agentMinimumGlibcVersion: string;
}

export interface KubernetesPydumpCaptureTools {
  readonly collector: string;
  readonly loader: string;
  readonly agent: string;
  readonly agentMinimumGlibcVersion: string;
  readonly toolkitVersion?: string;
  readonly bundleVersion: string;
}

function pydumpPrereqDeficiencies(prereqs: ReturnType<typeof parsePydumpPrereqs>): string[] {
  if (!prereqs) return ["前置探测输出无法解析"];
  const missing: string[] = [];
  if (!prereqs.python3) missing.push("python3");
  if (!prereqs.writable) missing.push(`可写目录 ${PYDUMP_TOOL_DIR}`);
  return missing;
}

function pydumpFailureReason(result: Parameters<typeof failReason>[0]): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.some((line) => /Program terminated with signal SIGKILL/i.test(line))) {
    return "目标进程在 dump 期间被 SIGKILL";
  }
  const specificError = lines.slice().reverse().find(
    (line) => !line.toLowerCase().startsWith("warning:")
      && /\b(error|failed|failure|exception)\b/i.test(line)
      && line !== "Dumping finished with error",
  );
  return specificError ?? failReason(result);
}

function componentPath(
  components: Readonly<Record<string, { path: string }>>,
  role: string,
): string {
  const path = components[role]?.path;
  if (!path) throw new Error(`Pydump Toolkit bundle 缺少 ${role} component`);
  return path;
}

/** Resolve one protocol-compatible Collector/pydump-loader/Agent set from one Toolkit archive. */
export function resolveKubernetesPydumpCaptureTools(input: {
  pod: string;
  container: string;
  architecture: string;
  pythonMinor: string;
  targetGlibcVersion: string;
}): KubernetesPydumpCaptureTools {
  const channel = kubernetesToolkitChannel(input);
  if (!channel) throw new Error(`Target architecture 不支持：${input.architecture}`);
  const resolved = resolveToolkitBundle(channel, {
    id: "pydump-capture",
    protocol: "pydump.capture/v1",
    runtime: { name: "cpython", version: input.pythonMinor },
    libc: { family: "glibc", version: input.targetGlibcVersion },
  });
  if (resolved) {
    const minimum = resolved.bundle.compatibility?.libc?.minimumVersion;
    if (!minimum) throw new Error("Pydump Toolkit bundle 缺少 libc compatibility");
    return {
      collector: componentPath(resolved.components, "collector"),
      loader: componentPath(resolved.components, "loader"),
      agent: componentPath(resolved.components, "agent"),
      agentMinimumGlibcVersion: minimum,
      toolkitVersion: resolved.archive.manifest.version,
      bundleVersion: resolved.bundle.version,
    };
  }

  // Source checkouts have no release archive. Discover their assets by filename for local tests.
  const agent = discoverDevelopmentPydumpAgents(channel.platform)
    .filter((item) => item.pythonMinor === input.pythonMinor)
    .filter((item) => (
      compareRuntimeVersions(input.targetGlibcVersion, item.minimumGlibcVersion) ?? -1
    ) >= 0)
    .sort((left, right) => (
      compareRuntimeVersions(right.minimumGlibcVersion, left.minimumGlibcVersion) ?? 0
    ))[0];
  const collector = resolveDevelopmentToolkitTool("pydump-collector", channel.platform);
  const loader = resolveDevelopmentToolkitTool("pydump-loader", channel.platform);
  if (agent && collector && loader) {
    return {
      collector,
      loader,
      agent: agent.path,
      agentMinimumGlibcVersion: agent.minimumGlibcVersion,
      bundleVersion: PYDUMP_VERSION,
    };
  }
  throw new Error(
    `Doctor Toolkit 缺少 ${channel.platform.os}/${channel.platform.architecture} `
    + `CPython ${input.pythonMinor} / glibc ${input.targetGlibcVersion} 兼容的 Pydump bundle`,
  );
}

/** Resolve the standalone Go analyzer that executes directly on Doctor Host. */
export function resolveHostPydumpAnalyzer(): string {
  const channel = hostProcessToolkitChannel();
  if (!channel) throw new Error("Doctor Host 平台不支持 Pydump analyzer");
  const resolved = resolveToolkitBundle(channel, {
    id: "pydump-analysis",
    protocol: "pydump.analysis/v1",
  });
  return resolved?.components.analyzer?.path
    ?? resolveDevelopmentToolkitTool("pydump-analyzer", channel.platform)
    ?? (() => { throw new Error("Doctor Toolkit 缺少 Host Pydump analyzer"); })();
}

async function prepareDebugExecution(
  context: HeapDumpBackendContext,
  debug: DebugEnvironmentFact,
): Promise<HeapDumpBackendResult<PydumpExecution>> {
  const target = { pod: context.pod, container: debug.executionContainer };
  const result = await context.executor.exec(target, pydumpPrereqCmd(), { timeoutMs: 20_000 });
  context.observe({ id: "mem-debug-prereq", title: "确认 debug container 的 Pydump 前置", result });
  const prereqs = result.ok ? parsePydumpPrereqs(result.stdout) : undefined;
  const missing = pydumpPrereqDeficiencies(prereqs);
  if (missing.length) {
    return {
      reason: `debug environment ${debug.executionContainer}（image=${debug.image}）缺少：${missing.join("、")}`,
    };
  }
  const execution: PydumpExecution = {
    strategy: "debug-container",
    target,
    container: debug.executionContainer,
    label: `${context.pod}/${debug.executionContainer}`,
    collectorPath: prereqs?.collector ? PYDUMP_COLLECTOR_PATH : TARGET_COLLECTOR_PATH,
    loaderPath: prereqs?.loader ? PYDUMP_LOADER_PATH : TARGET_LOADER_PATH,
  };
  const ptraceReason = await context.verifyPtrace(execution);
  return ptraceReason ? { reason: `debug container 无法 attach：${ptraceReason}` } : { value: execution };
}

async function prepareTargetExecution(
  context: HeapDumpBackendContext,
): Promise<HeapDumpBackendResult<PydumpExecution>> {
  const target = { pod: context.pod, container: context.targetContainer.name };
  const result = await context.executor.exec(
    target,
    pydumpPrereqCmd(TARGET_COLLECTOR_PATH, TARGET_LOADER_PATH),
    { timeoutMs: 20_000 },
  );
  context.observe({ id: "mem-target-prereq", title: "确认目标容器的 Pydump attach 前置", result });
  const prereqs = result.ok ? parsePydumpPrereqs(result.stdout) : undefined;
  const missing = pydumpPrereqDeficiencies(prereqs);
  if (missing.length) {
    return { reason: `目标容器 ${context.targetContainer.name} 缺少：${missing.join("、")}` };
  }
  const execution: PydumpExecution = {
    strategy: "target-container",
    target,
    container: context.targetContainer.name,
    label: `${context.pod}/${context.targetContainer.name}`,
    collectorPath: TARGET_COLLECTOR_PATH,
    loaderPath: TARGET_LOADER_PATH,
  };
  const ptraceReason = await context.verifyPtrace(execution);
  return ptraceReason ? { reason: `目标容器无法 attach：${ptraceReason}` } : { value: execution };
}

async function inspectRuntime(
  context: HeapDumpBackendContext,
  execution: PydumpExecution,
) {
  const libc = await context.executor.exec(
    { pod: context.pod, container: context.targetContainer.name },
    targetLibcCmd(context.pid),
    { timeoutMs: 10_000 },
  );
  context.observe({ id: "mem-target-libc", title: "识别目标 Python 进程的 libc", result: libc });
  const targetLibc = libc.ok ? parsePydumpTargetLibc(libc.stdout) : undefined;
  if (!targetLibc) return { reason: `无法识别目标 Python 进程的 libc：${failReason(libc)}` };
  if (targetLibc.family !== "glibc" || !targetLibc.version) {
    return {
      reason: targetLibc.family === "musl"
        ? "目标 Python 使用 musl；Pydump Agent 当前只支持 glibc"
        : `无法确认目标 Python 使用的 glibc 版本：${targetLibc.raw ?? "unknown"}`,
    };
  }
  const python = await context.executor.exec(execution.target, targetPythonMinorCmd(context.pid), {
    timeoutMs: 10_000,
  });
  context.observe({ id: "mem-python-minor", title: "识别目标 CPython minor", result: python });
  const pythonMinor = python.ok ? parseTargetPythonMinor(python.stdout) : undefined;
  if (!pythonMinor) return { reason: `无法识别目标 CPython minor：${failReason(python)}` };
  const platform = await context.executor.exec(execution.target, ["uname", "-m"], { timeoutMs: 10_000 });
  context.observe({ id: "mem-toolkit-platform", title: "识别 Toolkit 执行平台", result: platform });
  if (!platform.ok || !platform.stdout.trim()) {
    return { reason: `无法识别 ${execution.label} 的 architecture：${failReason(platform)}` };
  }
  const architecture = platform.stdout.trim();
  if (!/^(?:x86_64|aarch64|amd64|arm64)$/.test(architecture)) {
    return { reason: `Target architecture 不支持：${architecture}` };
  }
  let existingAgent: ExistingPydumpAgent | undefined;
  if (
    execution.collectorPath !== TARGET_COLLECTOR_PATH
    && execution.loaderPath !== TARGET_LOADER_PATH
  ) {
    const inventory = await context.executor.exec(
      execution.target,
      pydumpAgentInventoryCmd(pythonMinor, architecture),
      { timeoutMs: 10_000 },
    );
    context.observe({
      id: "mem-pydump-agent-inventory",
      title: "识别执行容器内的 Pydump Agent",
      result: inventory,
    });
    existingAgent = inventory.ok
      ? selectPydumpAgentFromInventory(
          inventory.stdout,
          pythonMinor,
          architecture,
          targetLibc.version,
        )
      : undefined;
  }
  let state: PydumpRuntimeSelection;
  if (existingAgent) {
    state = {
      source: "execution-image",
      pythonMinor,
      architecture,
      targetLibc,
      existingAgent,
    };
  } else {
    let tools: KubernetesPydumpCaptureTools;
    try {
      tools = resolveKubernetesPydumpCaptureTools({
        pod: context.pod,
        container: execution.container,
        architecture,
        pythonMinor,
        targetGlibcVersion: targetLibc.version,
      });
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
    state = {
      source: "toolkit",
      pythonMinor,
      architecture,
      targetLibc,
      tools,
    };
  }
  const minimumGlibcVersion = state.source === "execution-image"
    ? state.existingAgent.minimumGlibcVersion
    : state.tools.agentMinimumGlibcVersion;
  return {
    value: {
      state,
      summary: [
        `[collect] Pydump Agent：CPython ${state.pythonMinor} / ${state.architecture}，`
          + `目标 glibc ${state.targetLibc.version}，匹配最低 glibc `
          + `${minimumGlibcVersion} 的 Agent`,
      ],
      facts: { target_libc: state.targetLibc },
    },
  };
}

async function prepare(
  context: HeapDumpBackendContext,
  execution: PydumpExecution,
  runtime: PydumpRuntimeSelection,
): Promise<HeapDumpBackendResult<{
  state: PreparedPydumpTools;
  version: string;
  summary: readonly string[];
  facts: Readonly<Record<string, unknown>>;
}>> {
  if (runtime.source === "execution-image") {
    return {
      value: {
        version: PYDUMP_VERSION,
        state: {
          collectorPath: execution.collectorPath,
          loaderPath: execution.loaderPath,
          agentPath: runtime.existingAgent.path,
          agentMinimumGlibcVersion: runtime.existingAgent.minimumGlibcVersion,
        },
        summary: [
          `[collect] Pydump bundle：复用执行容器已有组件，Agent 最低 glibc `
            + runtime.existingAgent.minimumGlibcVersion,
        ],
        facts: {
          pydump_bundle: {
            protocol: "pydump.capture/v1",
            version: PYDUMP_VERSION,
            source: "execution-image",
          },
          pydump_agent: {
            python_minor: runtime.pythonMinor,
            architecture: runtime.architecture,
            glibc_min: runtime.existingAgent.minimumGlibcVersion,
          },
        },
      },
    };
  }
  const tools = runtime.tools;
  const imageAgentPath = pydumpImageAgentPath(
    runtime.pythonMinor,
    runtime.architecture,
    tools.agentMinimumGlibcVersion,
  );
  const bundledAgent = await context.executor.exec(execution.target, ["test", "-r", imageAgentPath], {
    timeoutMs: 10_000,
  });
  const needCollector = execution.collectorPath === TARGET_COLLECTOR_PATH;
  const needLoader = execution.loaderPath === TARGET_LOADER_PATH;
  const needAgent = !bundledAgent.ok;
  if (needCollector) {
    const result = await hostTargetFileTransfer.uploadToTarget({
      executor: context.executor,
      target: execution.target,
      hostPath: tools.collector,
      targetPath: TARGET_COLLECTOR_PATH,
    });
    context.observe({ id: "mem-upload-collector", title: "临时上传 Pydump Collector", result, effect: "overhead" });
    if (!result.ok) return { reason: `Pydump Collector 上传失败：${failReason(result)}` };
  }
  if (needLoader) {
    const result = await hostTargetFileTransfer.uploadToTarget({
      executor: context.executor,
      target: execution.target,
      hostPath: tools.loader,
      targetPath: TARGET_LOADER_PATH,
    });
    context.observe({
      id: "mem-upload-pydump-loader",
      title: "临时上传 pydump-loader",
      result,
      effect: "overhead",
    });
    if (!result.ok) return { reason: `pydump-loader 上传失败：${failReason(result)}` };
  }
  const agentPath = needAgent
    ? pydumpUploadedAgentPath(
        runtime.pythonMinor,
        runtime.architecture,
        tools.agentMinimumGlibcVersion,
      )
    : imageAgentPath;
  if (needAgent) {
    const result = await hostTargetFileTransfer.uploadToTarget({
      executor: context.executor,
      target: execution.target,
      hostPath: tools.agent,
      targetPath: agentPath,
    });
    context.observe({
      id: "mem-upload-agent",
      title: `临时上传 CPython ${runtime.pythonMinor} / 最低 glibc ${tools.agentMinimumGlibcVersion} Agent`,
      result,
      effect: "overhead",
    });
    if (!result.ok) return { reason: `Pydump Agent 上传失败：${failReason(result)}` };
  }
  const collectorPath = needCollector ? TARGET_COLLECTOR_PATH : execution.collectorPath;
  const loaderPath = needLoader ? TARGET_LOADER_PATH : execution.loaderPath;
  const verify = await context.executor.exec(
    execution.target,
    ["sh", "-c", `test -x ${collectorPath} && test -x ${loaderPath} && test -r ${agentPath}`],
    { timeoutMs: 10_000 },
  );
  context.observe({
    id: "mem-pydump-tools",
    title: "确认 Pydump Collector、pydump-loader 与 Agent",
    result: verify,
  });
  if (!verify.ok) return { reason: "Pydump Collector、pydump-loader 或 Agent 上传后不可用" };
  return {
    value: {
      version: tools.bundleVersion,
      state: {
        collectorPath,
        loaderPath,
        agentPath,
        agentMinimumGlibcVersion: tools.agentMinimumGlibcVersion,
      },
      summary: [
        `[collect] Pydump bundle：pydump.capture/v1，Agent 最低 glibc `
          + tools.agentMinimumGlibcVersion,
      ],
      facts: {
        pydump_bundle: {
          protocol: "pydump.capture/v1",
          version: tools.bundleVersion,
          toolkit_version: tools.toolkitVersion,
        },
        pydump_agent: {
          python_minor: runtime.pythonMinor,
          architecture: runtime.architecture,
          glibc_min: tools.agentMinimumGlibcVersion,
        },
      },
    },
  };
}

export const pydumpBackend: HeapDumpBackend<
  PydumpExecution,
  PydumpRuntimeSelection,
  PreparedPydumpTools
> = {
  kind: "pydump",
  displayName: "Pydump",
  logName: "pydump",
  toolDir: PYDUMP_TOOL_DIR,
  version: PYDUMP_VERSION,
  cleanupCommand: cleanupPydumpCmd,
  prepareDebugExecution,
  prepareTargetExecution,
  inspectRuntime,
  prepare,
  dumpCommand: ({ pid, heapFile, strReprLen, noAttribute, prepared }) => runPydumpDumpCmd(
    pid,
    heapFile,
    strReprLen,
    prepared.agentPath,
    prepared.loaderPath,
    noAttribute,
    prepared.collectorPath,
  ),
  failureReason: pydumpFailureReason,
};
