import { hostTargetFileTransfer } from "../file-transfer";
import { failReason } from "../k8s/result";
import {
  kubernetesToolkitChannel,
  resolveDevelopmentToolkitTool,
  resolveToolkitBundle,
} from "../toolkit";
import { debugEngine } from "../target/debug";
import {
  cleanupPyheapCmd,
  parsePyheapPrereqs,
  pyheapPrereqCmd,
  PYHEAP_DUMP_PATH,
  PYHEAP_TOOL_DIR,
  PYHEAP_VERSION,
  runPyheapDumpCmd,
} from "./pyheap-tool";
import type {
  HeapDumpBackend,
  HeapDumpBackendContext,
  HeapDumpBackendResult,
  HeapDumpExecution,
} from "./model";
import type { DebugEnvironmentFact } from "../target/debug";

const TARGET_PYHEAP_DUMPER_PATH = `${PYHEAP_TOOL_DIR}/pyheap_dump`;

export interface PyheapExecution extends HeapDumpExecution {
  readonly dumpPath: string;
}

function pyheapPrereqDeficiencies(
  prereqs: ReturnType<typeof parsePyheapPrereqs>,
): string[] {
  if (!prereqs) return ["前置探测输出无法解析"];
  const missing: string[] = [];
  if (!prereqs.python3) missing.push("python3");
  if (!prereqs.gdb) missing.push("gdb");
  else if (!prereqs.gdbPython) missing.push("支持 Python scripting 的 gdb");
  if (!prereqs.writable) missing.push(`可写目录 ${PYHEAP_TOOL_DIR}`);
  return missing;
}

async function verifyGdbReadiness(input: {
  context: HeapDumpBackendContext;
  target: { pod: string; container: string };
  stepId: string;
  title: string;
}): Promise<string | undefined> {
  const gdb = await debugEngine.inspectGdb(
    input.context.executor,
    input.target.pod,
    input.target.container,
  );
  const ready = gdb.available && gdb.pythonScripting && gdb.inferiorCall;
  input.context.observe({
    id: input.stepId,
    title: input.title,
    status: ready ? "ok" : "failed",
    reason: ready ? undefined : gdb.reason ?? "fork-pyheap 所需 GDB 能力验收未通过",
    output: `${JSON.stringify(gdb, null, 2)}\n`,
  });
  return ready
    ? undefined
    : `GDB ${gdb.version ?? "version unknown"} 不满足 fork-pyheap attach 前置：`
      + `${gdb.reason ?? "Python scripting 或 inferior call 验收未通过"}`;
}

async function prepareDebugExecution(
  context: HeapDumpBackendContext,
  debug: DebugEnvironmentFact,
): Promise<HeapDumpBackendResult<PyheapExecution>> {
  const target = { pod: context.pod, container: debug.executionContainer };
  const result = await context.executor.exec(target, pyheapPrereqCmd(), { timeoutMs: 20_000 });
  context.observe({ id: "mem-debug-prereq", title: "确认 debug container 的 fork-pyheap 前置", result });
  const prereqs = result.ok ? parsePyheapPrereqs(result.stdout) : undefined;
  const missing = pyheapPrereqDeficiencies(prereqs);
  if (missing.length) {
    return {
      reason: `debug environment ${debug.executionContainer}（image=${debug.image}）缺少：${missing.join("、")}`,
    };
  }
  const gdbReason = await verifyGdbReadiness({
    context,
    target,
    stepId: "mem-debug-gdb",
    title: "验证 debug container 的 GDB attach 能力",
  });
  if (gdbReason) {
    return {
      reason: `debug environment ${debug.executionContainer}（image=${debug.image}）的 ${gdbReason}；`
        + "请更换包含兼容 GDB 的 doctor debug image，或对该 debug container 执行 doctor install gdb",
    };
  }
  const execution: PyheapExecution = {
    strategy: "debug-container",
    target,
    container: debug.executionContainer,
    label: `${context.pod}/${debug.executionContainer}`,
    dumpPath: prereqs?.dumper ? PYHEAP_DUMP_PATH : TARGET_PYHEAP_DUMPER_PATH,
  };
  const ptraceReason = await context.verifyPtrace(execution);
  return ptraceReason ? { reason: `debug container 无法 attach：${ptraceReason}` } : { value: execution };
}

async function prepareTargetExecution(
  context: HeapDumpBackendContext,
): Promise<HeapDumpBackendResult<PyheapExecution>> {
  const target = { pod: context.pod, container: context.targetContainer.name };
  const result = await context.executor.exec(
    target,
    pyheapPrereqCmd(TARGET_PYHEAP_DUMPER_PATH),
    { timeoutMs: 20_000 },
  );
  context.observe({ id: "mem-target-prereq", title: "确认目标容器的 fork-pyheap attach 前置", result });
  const prereqs = result.ok ? parsePyheapPrereqs(result.stdout) : undefined;
  const missing = pyheapPrereqDeficiencies(prereqs);
  if (missing.length) {
    return { reason: `目标容器 ${context.targetContainer.name} 缺少：${missing.join("、")}` };
  }
  const gdbReason = await verifyGdbReadiness({
    context,
    target,
    stepId: "mem-target-gdb",
    title: "验证目标容器的 GDB attach 能力",
  });
  if (gdbReason) {
    return { reason: `目标容器 ${context.targetContainer.name} 的 ${gdbReason}；请先对该容器执行 doctor install gdb` };
  }
  const execution: PyheapExecution = {
    strategy: "target-container",
    target,
    container: context.targetContainer.name,
    label: `${context.pod}/${context.targetContainer.name}`,
    dumpPath: TARGET_PYHEAP_DUMPER_PATH,
  };
  const ptraceReason = await context.verifyPtrace(execution);
  return ptraceReason ? { reason: `目标容器无法 attach：${ptraceReason}` } : { value: execution };
}

/** Resolve fork-pyheap as a complete (currently single-component) capture bundle. */
export function resolveKubernetesPyHeapDumper(input: {
  pod: string;
  container: string;
  architecture: string;
}): string {
  const channel = kubernetesToolkitChannel(input);
  if (!channel) throw new Error(`Target architecture 不支持：${input.architecture}`);
  const resolved = resolveToolkitBundle(channel, {
    id: "pyheap-capture",
    protocol: "fork-pyheap.capture/v1",
  });
  return resolved?.components.dumper?.path
    ?? resolveDevelopmentToolkitTool("fork-pyheap-dumper", channel.platform)
    ?? (() => {
      throw new Error(
        `Doctor Toolkit 缺少 ${channel.platform.os}/${channel.platform.architecture} fork-pyheap bundle`,
      );
    })();
}

function pyheapFailureReason(result: Parameters<typeof failReason>[0]): string {
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

export const pyheapBackend: HeapDumpBackend<PyheapExecution, undefined, undefined> = {
  kind: "pyheap",
  displayName: "fork-pyheap",
  logName: "fork-pyheap",
  toolDir: PYHEAP_TOOL_DIR,
  version: PYHEAP_VERSION,
  confirmationWarning: "fork-pyheap 在目标 Python 进程内遍历对象，目标 cgroup 内存可能显著上升",
  cleanupCommand: cleanupPyheapCmd,
  prepareDebugExecution,
  prepareTargetExecution,
  inspectRuntime: async () => ({ value: { state: undefined, summary: [], facts: {} } }),
  prepare: async (context, execution) => {
    if (execution.dumpPath === PYHEAP_DUMP_PATH) return { value: { state: undefined } };
    const platform = await context.executor.exec(execution.target, ["uname", "-m"], {
      timeoutMs: 10_000,
    });
    context.observe({ id: "mem-toolkit-platform", title: "识别 Toolkit 执行平台", result: platform });
    if (!platform.ok || !platform.stdout.trim()) {
      return { reason: `无法识别 ${execution.label} 的 architecture：${failReason(platform)}` };
    }
    let dumper: string;
    try {
      dumper = resolveKubernetesPyHeapDumper({
        pod: context.pod,
        container: execution.container,
        architecture: platform.stdout.trim(),
      });
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
    const upload = await hostTargetFileTransfer.uploadToTarget({
      executor: context.executor,
      target: execution.target,
      hostPath: dumper,
      targetPath: TARGET_PYHEAP_DUMPER_PATH,
    });
    context.observe({ id: "mem-upload-dumper", title: "临时上传 fork-pyheap dumper", result: upload, effect: "overhead" });
    if (!upload.ok) return { reason: `fork-pyheap dumper 上传失败：${failReason(upload)}` };
    const verify = await context.executor.exec(
      execution.target,
      pyheapPrereqCmd(TARGET_PYHEAP_DUMPER_PATH),
      { timeoutMs: 20_000 },
    );
    context.observe({ id: "mem-pyheap-tool", title: "确认 fork-pyheap dumper", result: verify });
    const prereqs = verify.ok ? parsePyheapPrereqs(verify.stdout) : undefined;
    return prereqs?.dumper
      ? { value: { state: undefined } }
      : { reason: "fork-pyheap dumper 上传后不可用" };
  },
  dumpCommand: ({ execution, pid, heapFile, strReprLen, noAttribute }) => runPyheapDumpCmd(
    pid,
    heapFile,
    strReprLen,
    noAttribute,
    execution.dumpPath,
  ),
  failureReason: pyheapFailureReason,
};
