import { writeErrorLog } from "../../app/error-log";
import type { DebugEnvironmentFacts } from "../../infra/target/debug";
import type { ExecResult, ExecTarget } from "../../infra/k8s/executor";
import type { CpuCollectContext } from "./context";
import type { CpuPythonFacts } from "./fact/python";
import {
  parsePtraceFacts,
  podDeclaresSysPtrace,
  ptraceFactsCmd,
  type PtraceFacts,
} from "../fact/ptrace";
import { EvidenceBundle, type StepRisk } from "../evidence";
import { failReason } from "../../infra/k8s/result";
import {
  DOCTOR_DEBUG_PY_SPY_PATH,
  pySpyDumpCmd,
  pySpyPrereqCmd,
} from "./probes";

interface PySpyCollectInput extends CpuCollectContext {
  pid: number;
  capabilityFacts?: CpuPythonFacts;
  ptraceFacts?: PtraceFacts;
  debug?: DebugEnvironmentFacts;
  onPySpyDump?: (output: string) => void;
}

export interface PySpyRecoveryFacts {
  initialAttachLikely: boolean;
  strategy?: "current-container" | "debug-container";
  captured: boolean;
  reason?: string;
}

function record(
  bundle: EvidenceBundle,
  id: string,
  title: string,
  result: ExecResult,
  ext = "txt",
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
    ext,
  });
}

function finish(
  input: PySpyCollectInput,
  result: PySpyRecoveryFacts,
): PySpyRecoveryFacts {
  input.bundle.fill("py-spy-dump", result.captured
    ? { status: "ok" }
    : { status: "unavailable", reason: result.reason ?? "py-spy 线程栈未采集到" });
  if (result.reason) input.notes.push(`py-spy: ${result.reason}`);
  return result;
}

async function dumpPySpy(
  input: PySpyCollectInput,
  target: ExecTarget,
  path: string,
  id: string,
): Promise<{ ok: boolean; reason?: string }> {
  const result = await input.exec.exec(target, pySpyDumpCmd(path, input.pid), { timeoutMs: 30_000 });
  record(input.bundle, id, "py-spy 非阻塞线程栈", result, "txt", "overhead");
  if (!result.ok) return { ok: false, reason: failReason(result) };
  if (!result.stdout.trim()) return { ok: false, reason: "py-spy 未返回线程栈" };
  input.onPySpyDump?.(result.stdout);
  return { ok: true };
}

async function collectFromCurrentContainer(
  input: PySpyCollectInput,
): Promise<PySpyRecoveryFacts> {
  const initialAttachLikely = input.ptraceFacts?.attachLikely === true;
  if (!initialAttachLikely) {
    return {
      initialAttachLikely,
      captured: false,
      reason: `${input.ptraceFacts?.reason ?? "未取得 ptrace Facts"}；可先执行 doctor debug，再使用 --mode disrupt`,
    };
  }
  const path = input.capabilityFacts?.pySpyPath;
  if (!path) {
    return {
      initialAttachLikely,
      captured: false,
      reason: "目标容器没有已有 py-spy；可先执行 doctor debug，再使用 --mode disrupt",
    };
  }
  const result = await dumpPySpy(
    input,
    { pod: input.podName, container: input.container.name },
    path,
    "py-spy-current-dump",
  );
  return {
    initialAttachLikely,
    strategy: "current-container",
    captured: result.ok,
    reason: result.reason,
  };
}

async function collectFromDebugContainer(
  input: PySpyCollectInput,
): Promise<PySpyRecoveryFacts> {
  const initialAttachLikely = input.ptraceFacts?.attachLikely === true;
  const debug = input.debug?.selected;
  if (!debug) {
    return {
      initialAttachLikely,
      captured: false,
      reason: input.debug?.reason ?? "目标 Pod 中没有已就绪的 doctor debug 临时容器；请先执行 doctor debug",
    };
  }

  const target = { pod: input.podName, container: debug.executionContainer };
  const prereq = await input.exec.exec(target, pySpyPrereqCmd(), { timeoutMs: 20_000 });
  record(input.bundle, "py-spy-debug-prereq", "确认 debug 容器内 py-spy", prereq);
  if (!prereq.ok) {
    return {
      initialAttachLikely,
      strategy: "debug-container",
      captured: false,
      reason: `doctor debug 镜像没有可用 py-spy：${failReason(prereq)}`,
    };
  }

  const ptraceResult = await input.exec.exec(target, ptraceFactsCmd(input.pid), { timeoutMs: 20_000 });
  record(input.bundle, "py-spy-debug-ptrace", "debug 容器 ptrace 运行态复核", ptraceResult, "json");
  if (!ptraceResult.ok) {
    return {
      initialAttachLikely,
      strategy: "debug-container",
      captured: false,
      reason: failReason(ptraceResult),
    };
  }

  let ptrace: PtraceFacts;
  try {
    ptrace = parsePtraceFacts(
      ptraceResult.stdout,
      podDeclaresSysPtrace(input.podJson, debug.executionContainer),
    );
  } catch (error) {
    writeErrorLog(error, "doctor cpu/py-spy-debug-ptrace");
    return {
      initialAttachLikely,
      strategy: "debug-container",
      captured: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!ptrace.attachLikely) {
    return {
      initialAttachLikely,
      strategy: "debug-container",
      captured: false,
      reason: `doctor debug 临时容器不能 attach：${ptrace.reason}`,
    };
  }

  const result = await dumpPySpy(
    input,
    target,
    DOCTOR_DEBUG_PY_SPY_PATH,
    "py-spy-debug-dump",
  );
  return {
    initialAttachLikely,
    strategy: "debug-container",
    captured: result.ok,
    reason: result.reason,
  };
}

export async function collectPySpy(input: PySpyCollectInput): Promise<PySpyRecoveryFacts> {
  if (input.mode === "observe") {
    return finish(input, {
      initialAttachLikely: input.ptraceFacts?.attachLikely === true,
      captured: false,
      reason: "mode=observe 不 attach 目标进程",
    });
  }
  const result = input.mode === "overhead"
    ? await collectFromCurrentContainer(input)
    : await collectFromDebugContainer(input);
  return finish(input, result);
}
