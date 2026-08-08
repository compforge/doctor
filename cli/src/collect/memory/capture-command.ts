import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { infra } from "../../infra";
import type { ExecResult } from "../../infra/k8s/executor";
import { parsePodJson, pickContainer } from "../../infra/k8s/target";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { TerminalProgressLine } from "../../terminal/progress";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  resolvePodTarget,
  type KubernetesCommandInput,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { EvidenceBundle } from "../evidence";
import { failReason } from "../../infra/k8s/result";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { deliverFailureBundle } from "../output/failure-bundle";
import {
  captureMemoryHeap,
  parseCapturePreference,
  parsePyHeapDetail,
  parseStrReprLen,
  parseTransferChunkBytes,
  type CaptureResult,
  type CapturePreference,
  type PyHeapDetail,
} from "./capture";
import { cleanupPyheapCmd, PYHEAP_TOOL_DIR, PYHEAP_VERSION } from "./pyheap-tool";

export interface CollectMemoryCliOptions extends KubernetesCommandInput {
  pod?: string;
  container?: string;
  pid?: string;
  yes?: boolean;
  output?: string;
  detail?: string;
  strReprLen?: string;
  captureVia?: string;
  transferChunkSize?: string;
  cleanupRemote?: boolean;
}

function timestamp(date: Date): string {
  return date.toISOString().replaceAll(/[:-]/g, "").replace("T", "-").slice(0, 15);
}

function recordPodStep(bundle: EvidenceBundle, result: ExecResult): void {
  bundle.addStep({
    id: "mem-pod-json",
    title: "目标 Pod 对象",
    risk: "observe",
    status: result.ok ? "ok" : "failed",
    reason: result.ok ? undefined : failReason(result),
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.stdout,
    stderr: result.stderr,
  });
}

export async function runCollectMemory(
  opts: CollectMemoryCliOptions,
  commandContext?: CommandContext,
): Promise<number> {
  const invokedAt = new Date();
  let detail: PyHeapDetail;
  let preference: CapturePreference;
  let strReprLen: number;
  let transferChunkBytes: number;
  try {
    detail = parsePyHeapDetail(opts.detail);
    preference = parseCapturePreference(opts.captureVia);
    strReprLen = parseStrReprLen(opts.strReprLen, detail === "lite" ? -1 : 1000);
    transferChunkBytes = parseTransferChunkBytes(opts.transferChunkSize);
  } catch (error) {
    terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const collect = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!collect) return 130;
  terminalStdout.write(
    `[collect] namespace: ${collect.kubernetes.namespace}（${collect.kubernetes.namespaceSource}）\n`,
  );
  const executor = createKubernetesExecutor(collect);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(access, {
    command: "doctor mem",
    needs: [{
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "探测 Python 进程、attach 并回传 PyHeap",
    }],
  });
  let target;
  try {
    target = await resolvePodTarget({
      config: collect,
      executor,
      pod: opts.pod,
      container: opts.container,
      selectContainer: true,
      access,
      selection: {
        role: "diagnostic-target",
        purpose: "采集 Python 内存堆",
      },
    });
  } catch (error) {
    terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!target) return 130;

  const podJsonResult = await executor.run(["get", "pod", target.pod, "-o", "json"], {
    timeoutMs: 20_000,
  });
  if (!podJsonResult.ok) {
    terminalStderr.error(`[collect] 获取目标 Pod 失败：${failReason(podJsonResult)}\n`);
    return 2;
  }
  const pod = parsePodJson(podJsonResult.stdout);
  const selected = pickContainer(pod, target.container);
  if (!selected.ok) {
    terminalStderr.error(`[collect] ${selected.reason}\n`);
    return 2;
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-mem-"));
  const staging = join(stagingRoot, `doctor-mem-${target.pod}-${timestamp(invokedAt)}-evidence`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const bundle = new EvidenceBundle(staging);
  recordPodStep(bundle, podJsonResult);
  const progressLine = new TerminalProgressLine({
    isTTY: !!process.stdout.isTTY,
    write: (text) => terminalStdout.write(text),
  });
  const logs: string[] = [];
  const log = (line: string) => {
    progressLine.interrupt();
    logs.push(line);
    terminalStdout.write(`${line}\n`);
  };

  let result: CaptureResult;
  try {
    const rawPod = JSON.parse(podJsonResult.stdout) as { metadata?: { uid?: string } };
    result = await captureMemoryHeap(
      executor,
      {
        namespace: collect.kubernetes.namespace,
        pod: target.pod,
        podUid: rawPod.metadata?.uid,
        podJson: podJsonResult.stdout,
        container: selected.value,
        pidFlag: opts.pid,
        detail,
        strReprLen,
        preference,
        transferChunkBytes,
        output: opts.output,
        invokedAt,
        confirmed: !!opts.yes,
      },
      { bundle, progress: (update) => progressLine.update(update) },
      log,
    );
  } catch (error) {
    result = { code: 1, reason: error instanceof Error ? error.message : String(error) };
  }
  progressLine.interrupt();

  if (result.code === 0) {
    if (opts.cleanupRemote && result.strategy && result.pid) {
      const executionContainer = result.strategy === "target-container"
        ? selected.value.name
        : infra.target.debugEngine.inspect(
            podJsonResult.stdout,
            selected.value.name,
          ).selected?.executionContainer;
      if (executionContainer) {
        const cleanup = await executor.exec(
          { pod: target.pod, container: executionContainer },
          cleanupPyheapCmd(),
          { timeoutMs: 30_000 },
        );
        if (!cleanup.ok) log(`[collect] 容器内 ${PYHEAP_TOOL_DIR} 清理失败，可稍后手工删除`);
      }
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    terminalStdout.success(`[collect] PyHeap 文件：${result.heapPath}\n`);
    terminalStdout.write(`[collect] 采集索引：${result.capturePath}\n`);
    terminalStdout.write(`[collect] 下一步：doctor mema ${result.capturePath}\n`);
    return 0;
  }
  if (result.code === 130) {
    rmSync(stagingRoot, { recursive: true, force: true });
    terminalStderr.warning("[collect] 已取消，未执行 attach\n");
    return 130;
  }

  const reasons = result.reasons?.length
    ? result.reasons
    : [result.reason ?? "PyHeap 采集失败"];
  for (const reason of reasons) {
    terminalStderr.error(`[collect] ${reason}\n`);
  }
  if (result.remoteHeapPath) {
    terminalStdout.write(`[collect] 远端文件仍保留：${result.remoteHeapPath}\n`);
  }
  bundle.writeSummary(
    `# doctor mem\n\n- 目标：${collect.kubernetes.namespace}/${target.pod}/${selected.value.name}\n`
    + `- PID：${result.pid ?? "-"}\n- 结果：失败\n- 原因：\n`
    + `${reasons.map((reason) => `  - ${reason}`).join("\n")}\n`,
  );
  writeFileSync(join(staging, "doctor.log"), `${logs.join("\n")}\n`, { mode: 0o600 });
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      namespace: collect.kubernetes.namespace,
      pod: target.pod,
      container: selected.value.name,
      pid: result.pid,
    },
    inspectionFacts: {},
    params: {
      command: "mem",
      detail,
      str_repr_len: strReprLen,
      capture_via: preference,
      pyheap_version: PYHEAP_VERSION,
    },
    startedAt: invokedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const failure = await deliverFailureBundle({
    bundleDir: staging,
    bundleName: basename(staging),
    collectCode: result.code,
  });
  if (failure.packed.ok) {
    rmSync(stagingRoot, { recursive: true, force: true });
    terminalStdout.write(`[collect] 失败证据：${failure.path}\n`);
  } else {
    terminalStdout.write(`[collect] 原始失败证据：${staging}\n`);
  }
  return result.code;
}
