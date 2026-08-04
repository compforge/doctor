import { terminalStdout, terminalStderr } from "../../terminal/output";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { writeErrorLog } from "../../app/error-log";
import { runDiagnosis } from "../engine";
import { freezeFacts, runInspects } from "../inspect-engine";
import type { Detector } from "../protocol";
import { EvidenceBundle, type OutcomeDecl, type StepRisk } from "../evidence";
import { failReason } from "../../infra/k8s/result";
import { fillFromExec } from "../exec-step";
import { resolveCpuConfig } from "./config";
import type { ApprovalDecision } from "../../command/approval";
import { packBundle, resolveArchivePath } from "../output/archive";
import { deliverFailureBundle } from "../output/failure-bundle";
import {
  resolveApprovalGate,
  type ApprovalCliOptions,
} from "../../terminal/approval";
import {
  makeContainerCapabilitiesInspect,
  makeDebugInspect,
  makePlatformInspect,
  makeProcessInspect,
  makeResourceUsageInspect,
  type CommonTargetFacts,
  type CommonTargetInspectContext,
} from "../fact/inspect";
import { pickPid } from "../fact/process";
import { type ExecResult, type Executor } from "../../infra/k8s/executor";
import { parsePodJson, pickContainer } from "../../infra/k8s/target";
import { cpuPythonFactsCmd, parseCpuPythonFacts } from "./fact/python";
import type { CpuDiagnosisFacts, CpuInspectionFacts } from "./fact/model";
import { parsePtraceFacts, podDeclaresSysPtrace, ptraceFactsCmd } from "../fact/ptrace";
import { PY_SPY_VERSION } from "./probes";
import { makePySpyProbe } from "./probe/py-spy";
import {
  buildCpuEvidence,
  type CpuCheckOptions,
  type CpuDiagnosis,
  type CpuEvidence,
  type CpuFinding,
  type CpuProbeContext,
} from "./model";
import { buildCpuMarkdown } from "./render";
import type { CommandContext } from "../../command";

export interface CollectCpuCliOpts extends ApprovalCliOptions {
  namespace?: string;
  pod?: string;
  container?: string;
  pid?: string;
  mode?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

export interface CpuCollectResult {
  code: number;
  diagnosis?: CpuDiagnosis;
}

const CPU_OUTCOMES: readonly OutcomeDecl[] = [
  { id: "platform-facts", title: "容器 OS/kernel/glibc 平台 Facts", risk: "observe" },
  { id: "process-scan", title: "Python 进程扫描 Fact", risk: "observe" },
  { id: "cpu-python-facts", title: "py-spy 运行环境 Facts", risk: "observe" },
  { id: "ptrace-facts", title: "ptrace/SYS_PTRACE Facts", risk: "observe" },
  { id: "py-spy-dump", title: "py-spy 非阻塞线程栈", risk: "overhead" },
];
const CPU_DETECTORS: readonly Detector<CpuEvidence, CpuFinding>[] = [];

export async function runCollectCpu(
  opts: CollectCpuCliOpts,
  commandContext?: CommandContext,
): Promise<number> {
  let resolved;
  try {
    resolved = await resolveCpuConfig(opts, commandContext);
  } catch (error) {
    terminalStderr.error(`[collect] ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!resolved) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  const { config, executor } = resolved;
  const bundleName = defaultCpuBundleName(config.target.pod, new Date());
  const outputPath = resolveArchivePath(config.output, bundleName);
  const staging = join(mkdtempSync(join(tmpdir(), "doctor-cpu-")), bundleName);
  const result = await collectCpu({
    config,
    outputDir: staging,
    approvalGate: resolveApprovalGate(opts),
  }, executor, (line) => terminalStdout.write(`${line}\n`));
  if (result.code === 130) {
    rmSync(join(staging, ".."), { recursive: true, force: true });
    return 130;
  }
  const delivery = result.code === 0
    ? { path: outputPath, packed: await packBundle(staging, outputPath) }
    : await deliverFailureBundle({
        bundleDir: staging,
        bundleName,
        requestedOutput: config.output,
        collectCode: result.code,
      });
  const { packed } = delivery;
  if (!packed.ok) {
    terminalStderr.error(`[collect] 打包失败：${failReason(packed)}\n[collect] 原始证据保留在目录: ${staging}\n`);
    return result.code || 1;
  }
  rmSync(join(staging, ".."), { recursive: true, force: true });
  terminalStdout.result(
    result.code === 0,
    `[collect] CPU ${result.code === 0 ? "证据包" : "失败 Evidence Bundle"}: ${delivery.path}\n`,
  );
  return result.code;
}

export async function collectCpu(
  opts: CpuCheckOptions,
  exec: Executor,
  log: (line: string) => void,
): Promise<CpuCollectResult> {
  const { collect, target: configuredTarget, mode, pidFlag } = opts.config;
  const namespace = collect.kubernetes.namespace;
  const { pod: podName, container: configuredContainer } = configuredTarget;
  const startedAt = new Date().toISOString();
  const bundle = new EvidenceBundle(opts.outputDir, CPU_OUTCOMES);
  const approvals = new Map<string, ApprovalDecision>();
  const notes: string[] = [];
  const inspection: CpuInspectionFacts = {};
  let resolvedContainer = configuredContainer;
  const record = (
    id: string,
    title: string,
    result: ExecResult,
    ext = "txt",
    risk: StepRisk = "observe",
  ) => bundle.addStep({
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
  let kubectlVersion: string | undefined;
  const finish = (code: number, diagnosis?: CpuDiagnosis): CpuCollectResult => {
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      kubectlVersion,
      target: { namespace, pod: podName, container: resolvedContainer, pid: inspection.pickedPid },
      inspectionFacts: inspection,
      params: { mode, pid_flag: pidFlag, py_spy_version: PY_SPY_VERSION },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return { code, diagnosis };
  };

  const version = await exec.run(["version", "--client"], { timeoutMs: 15_000 });
  record("kubectl-version", "kubectl 客户端版本", version);
  kubectlVersion = version.stdout.split("\n")[0]?.trim();
  if (!version.ok) {
    bundle.settle(`kubectl 不可用：${failReason(version)}`);
    bundle.writeSummary(`# CPU 采集失败\n\n${failReason(version)}\n`);
    return finish(2);
  }

  const podJson = await exec.run(["get", "pod", podName, "-o", "json"], { timeoutMs: 20_000 });
  record("pod-json", "Pod 对象（JSON）", podJson, "json");
  if (!podJson.ok) {
    bundle.settle(`Pod 不可用：${failReason(podJson)}`);
    bundle.writeSummary(`# CPU 采集失败\n\n${failReason(podJson)}\n`);
    return finish(1);
  }
  let pod;
  try {
    pod = parsePodJson(podJson.stdout);
  } catch (error) {
    writeErrorLog(error, "doctor cpu/parse-pod");
    bundle.settle("Pod JSON 解析失败");
    bundle.writeSummary(`# CPU 采集失败\n\nPod JSON 解析失败\n`);
    return finish(1);
  }
  const selected = pickContainer(pod, configuredContainer);
  if (!selected.ok) {
    bundle.settle(selected.reason);
    bundle.writeSummary(`# CPU 采集失败\n\n${selected.reason}\n`);
    return finish(1);
  }
  const container = selected.value;
  resolvedContainer = container.name;
  inspection.target = { pod, container };
  const target = { pod: podName, container: container.name };

  const commonFacts = await runInspects<CommonTargetFacts, CommonTargetInspectContext>([
    makeResourceUsageInspect(),
    makeContainerCapabilitiesInspect(),
    makeDebugInspect(),
    makePlatformInspect(),
    makeProcessInspect("process-scan", { requireProc: true, pidFlag }),
  ], {
    exec,
    target,
    podName,
    container,
    bundle,
    podJson: podJson.stdout,
  }, log);
  const { canExec, hasPython, hasProc } = commonFacts;
  inspection.resourceUsage = commonFacts.resourceUsage;
  inspection.kubernetes = commonFacts.kubernetes;
  inspection.container = commonFacts.container;
  inspection.platform = commonFacts.platform;
  inspection.processScan = commonFacts.processScan;
  inspection.pickedPid = commonFacts.pickedPid;
  inspection.debug = commonFacts.debug;

  if (commonFacts.processScan) {
    const picked = pickPid(commonFacts.processScan, pidFlag);
    if (picked.ok) {
      if (picked.note) notes.push(picked.note);
      const pythonFacts = await exec.exec(target, cpuPythonFactsCmd(), { timeoutMs: 20_000 });
      fillFromExec(bundle, "cpu-python-facts", pythonFacts, "json");
      if (pythonFacts.ok) {
        try {
          inspection.pythonProcess = parseCpuPythonFacts(pythonFacts.stdout);
        } catch (error) {
          writeErrorLog(error, "doctor cpu/parse-python-facts");
          notes.push(`py-spy 运行环境 Facts 解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const ptrace = await exec.exec(target, ptraceFactsCmd(picked.value), { timeoutMs: 20_000 });
      fillFromExec(bundle, "ptrace-facts", ptrace, "json");
      if (ptrace.ok) {
        try {
          inspection.ptrace = parsePtraceFacts(
            ptrace.stdout,
            podDeclaresSysPtrace(podJson.stdout, container.name),
          );
        } catch (error) {
          writeErrorLog(error, "doctor cpu/parse-ptrace-facts");
          notes.push(`ptrace Facts 解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      notes.push(picked.reason);
      bundle.settle(picked.reason, ["cpu-python-facts", "ptrace-facts", "py-spy-dump"]);
    }
  } else if (canExec && hasPython && hasProc) {
    bundle.settle("进程扫描失败", ["cpu-python-facts", "ptrace-facts", "py-spy-dump"]);
  } else {
    bundle.settle("缺少 pods/exec、python3 或 /proc", [
      "platform-facts",
      "process-scan",
      "cpu-python-facts",
      "ptrace-facts",
      "py-spy-dump",
    ]);
  }

  freezeFacts(inspection);
  const facts = freezeFacts({
    ...inspection,
    canExec,
    hasPython,
    hasProc,
  }) as CpuDiagnosisFacts;
  const pySpyProbe = makePySpyProbe({
    podJson: podJson.stdout,
    podName,
    container,
  });
  const diagnosis = await runDiagnosis({
    ctx: {
      exec,
      target,
      bundle,
      approvalGate: opts.approvalGate,
      approvals,
      log,
      notes,
    } satisfies CpuProbeContext,
    facts,
    config: opts.config,
    probes: [pySpyProbe],
    log,
    buildEvidence: buildCpuEvidence,
    detectors: CPU_DETECTORS,
    buildCoverage: (evidence) => [{
      goal: "python-thread-stacks" as const,
      status: evidence.observations.length > 0 ? "sufficient" as const : "insufficient" as const,
      missingEvidence: evidence.observations.length > 0 ? [] : ["py-spy Python 线程栈快照"],
    }],
  });
  bundle.writeSummary(buildCpuMarkdown(diagnosis, mode));
  return finish(0, diagnosis);
}

export function defaultCpuBundleName(pod: string, now: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}`
    + `-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
  return `doctor-cpu-${pod}-${timestamp}`;
}
