import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { infra } from "../../infra";
import type { ExecResult } from "../../infra/k8s/executor";
import {
  listServiceChoices,
  rankRecentServiceChoices,
  recordRecentServiceTargets,
  type ServiceChoice,
} from "../../infra/k8s/service-selection";
import type { RecentSelections } from "../../infra/recent";
import { sleep } from "../../infra/host/process";
import { findSelectableFiles } from "../../terminal/file-selection";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { formatDoctorDebugCommand } from "../../terminal/debug-recommendation";
import {
  formatProgressBytes,
  TerminalProgressLine,
} from "../../terminal/progress";
import {
  matchListedChoice,
  printNumberedChoices,
  promptEnter,
  promptListedChoice,
} from "../../terminal/selection";
import {
  promptNamedChoices,
  type NamedChoiceSelectionInput,
} from "../../terminal/service-selection";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { EvidenceBundle } from "../evidence";
import { captureHttpResponse } from "../shared/http/capture";
import { loadHttpScenario } from "../shared/http/config";
import type { HttpCapture } from "../shared/http/capture";
import type { HttpRequestPlan } from "../shared/http/model";
import { packBundle, resolveArchivePath } from "../output/archive";
import { deliverFailureBundle } from "../output/failure-bundle";
import type {
  CollectNetworkCliOpts,
  CollectNetworkOptions,
  NetworkCaptureArtifact,
  NetworkCollectDependencies,
  NetworkCollectResult,
  NetworkPodTarget,
  NetworkTopology,
} from "./model";
import {
  inspectNetworkTopology,
  NETWORK_DEBUG_ENVIRONMENT_MISSING_REASON,
  parseNetworkServices,
} from "./topology";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_DRAIN_SECONDS = 3;
const DEFAULT_MAX_PCAP_MIB = 1024;
const DEFAULT_MAX_RESPONSE_MIB = 512;
const CONTROL_CONCURRENCY = 4;
const TRANSFER_CONCURRENCY = 2;

interface ArmedCapture {
  target: NetworkPodTarget;
  artifact: NetworkCaptureArtifact;
}

interface CaptureTransfer {
  target: NetworkPodTarget;
  artifact: NetworkCaptureArtifact;
  metadata: NonNullable<NetworkCaptureArtifact["metadata"]>;
  expectedBytes: number;
  targetPath: string;
  hostPath: string;
}

function logNetworkStage(deps: NetworkCollectDependencies, line: string): void {
  deps.log?.(line);
}

function reason(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0] || `exit=${result.exitCode ?? "unknown"}`;
}

function recordExec(
  bundle: EvidenceBundle,
  id: string,
  title: string,
  result: ExecResult,
  risk: "observe" | "overhead" = "observe",
  overrideReason?: string,
): void {
  bundle.addStep({
    id,
    title,
    risk,
    status: result.ok && !overrideReason ? "ok" : "failed",
    reason: overrideReason ?? (result.ok ? undefined : reason(result)),
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.stdout,
    stderr: result.stderr,
  });
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parsePositive(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} 需要正数: '${value}'`);
  return parsed;
}

export function findNetworkScenarioFiles(directory = "."): string[] {
  return findSelectableFiles(
    directory,
    (name, path) => {
      if (!/\.ya?ml$/i.test(name)) return false;
      try {
        loadHttpScenario(path);
        return true;
      } catch {
        return false;
      }
    },
  );
}

export async function resolveNetworkScenarioFile(input: {
  file?: string;
  directory?: string;
  interactive?: boolean;
  prompt?: (files: readonly string[]) => Promise<string | null | undefined>;
}): Promise<string | null | undefined> {
  if (input.file?.trim()) return input.file;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error("缺少 --file；非交互环境请显式指定 YAML");
  }

  const directory = input.directory ?? ".";
  const files = findNetworkScenarioFiles(directory);
  if (!files.length) {
    terminalStdout.info("[net] 当前目录没有 doctor-http/v1 YAML，进入守候模式。\n");
    return null;
  }
  printNumberedChoices(files, "[net] 当前目录可用的 HTTP 场景：", (file) => file);
  const selected = input.prompt
    ? await input.prompt(files)
    : await promptListedChoice<string | null>({
        question: "请选择 YAML（序号或文件名，回车进入守候模式，q 取消）：",
        match: (answer) => matchListedChoice(files, answer, (file) => file, (file) => file),
        invalidMessage: "输入无效，请输入列表中的序号或文件名。",
        emptyValue: null,
      });
  if (selected === undefined) {
    terminalStdout.warning("已取消网络抓包场景选择。\n");
    return undefined;
  }
  if (selected === null) {
    terminalStdout.info("[net] 模式：守候（doctor 不主动发起请求）\n");
    return null;
  }
  return join(directory, selected);
}

function networkRequestLabel(request: HttpRequestPlan): string {
  return request.entrypointId === "default"
    ? request.requestId
    : `${request.requestId}/${request.entrypointId}`;
}

async function promptNetworkRequest(
  requests: readonly HttpRequestPlan[],
): Promise<HttpRequestPlan | undefined> {
  printNumberedChoices(
    requests,
    "[net] 当前场景可用的 HTTP 请求：",
    (request) => `${networkRequestLabel(request)}  ${request.method} ${request.url}`,
  );
  return promptListedChoice({
    question: "请选择请求（序号或 request id，q 取消）：",
    match: (answer) => matchListedChoice(
      requests,
      answer,
      networkRequestLabel,
      (request) => request,
    ),
    invalidMessage: "输入无效，请输入列表中的序号或 request id。",
  });
}

export async function resolveNetworkRequest(
  requests: readonly HttpRequestPlan[],
  input: {
    interactive?: boolean;
    prompt?: (requests: readonly HttpRequestPlan[]) => Promise<HttpRequestPlan | undefined>;
  } = {},
): Promise<HttpRequestPlan | undefined> {
  if (requests.length === 1) return requests[0];

  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(`doctor net 要求场景恰好解析出一个 HTTP 请求，实际为 ${requests.length} 个`);
  }

  const selected = await (input.prompt ?? promptNetworkRequest)(requests);
  if (!selected) terminalStdout.warning("已取消网络请求选择。\n");
  return selected;
}

export async function resolveNetworkServiceScope(input: {
  services?: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  interactive?: boolean;
  recent?: RecentSelections;
  loadChoices: () => Promise<ServiceChoice[]>;
  prompt?: (input: NamedChoiceSelectionInput<ServiceChoice>) => Promise<string[] | undefined>;
}): Promise<string[] | undefined> {
  if (input.services?.trim()) return parseNetworkServices(input.services);

  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error("缺少 --services；非交互环境请显式指定本次抓包范围");
  }
  const listed = await input.loadChoices();
  const choices = input.namespace
    ? rankRecentServiceChoices(listed, {
        namespace: input.namespace,
        kubeconfig: input.kubeconfig,
        context: input.context,
        interactive: input.interactive,
        recent: input.recent,
      })
    : listed;
  if (!choices.length) throw new Error("当前 namespace 没有可选 Kubernetes Service");
  const selected = await (input.prompt ?? promptNamedChoices)({
    choices,
    defaults: [],
    candidateType: "Service",
    context: { purpose: "确定本次抓包范围" },
  });
  if (!selected) terminalStdout.warning("已取消网络抓包范围选择。\n");
  if (selected && input.namespace) {
    recordRecentServiceTargets(selected, {
      namespace: input.namespace,
      kubeconfig: input.kubeconfig,
      context: input.context,
      interactive: input.interactive,
      recent: input.recent,
    });
  }
  return selected;
}

function bundleStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function defaultNetworkBundleName(now: Date): string {
  return `doctor-net-${bundleStamp(now)}`;
}

export function injectCaptureHeader(request: HttpRequestPlan, captureId: string): HttpRequestPlan {
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "x-doctor-capture-id"),
  );
  return { ...request, headers: { ...headers, "X-Doctor-Capture-ID": captureId } };
}

function extractTraceIds(response: HttpCapture, headersPath: string): string[] {
  const found = new Set<string>();
  for (const frame of response.sse?.frames ?? []) {
    if (frame.traceId) found.add(frame.traceId);
  }
  let headers = "";
  try {
    headers = readFileSync(headersPath, "utf-8");
  } catch {
    return [...found];
  }
  for (const match of headers.matchAll(/^(?:x-(?:tt-)?trace-id|trace-id):\s*([^\s]+)\s*$/gim)) {
    if (match[1]) found.add(match[1]);
  }
  for (const match of headers.matchAll(/^traceparent:\s*[\da-f]{2}-([\da-f]{32})-/gim)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function responseComplete(response: HttpCapture | undefined): boolean {
  return !!response?.response.captureComplete;
}

export function formatNetworkFailureSummary(result: NetworkCollectResult): string {
  const hasDeliveredPcap = result.artifacts.some((item) => item.verified);
  const lines = [
    `[net] ${hasDeliveredPcap ? "采集不完整" : "失败"}：`
    + `${result.reason ?? "网络抓包未完整完成"}`,
  ];
  const requiredGaps = result.topology?.missing.filter((item) => item.required) ?? [];
  if (requiredGaps.length) {
    lines.push(`[net] 必需覆盖缺口（${requiredGaps.length}）：`);
    for (const gap of requiredGaps) {
      lines.push(`  - ${gap.pod ? `Pod ${gap.pod}` : `Service ${gap.service ?? "unknown"}`}：${gap.reason}`);
    }
  }

  const targetCount = result.topology?.targets.length ?? 0;
  lines.push(`[net] 抓包目标：${targetCount} 个 Pod`);
  if (!result.artifacts.length) {
    lines.push("[net] PCAP：未开始");
  } else {
    lines.push(...formatNetworkCaptureStatus(result).trimEnd().split("\n"));
  }

  const response = result.response?.response;
  if (result.captureMode === "watch") {
    lines.push("[net] 模式：守候（doctor 未主动发起请求）");
  } else if (!response) {
    lines.push("[net] HTTP：未执行或未取得响应");
  } else {
    lines.push(
      `[net] HTTP：status=${response.statusCode ?? "未取得"}`
      + `，termination=${response.terminationReason}`
      + `${response.error ? `，error=${response.error}` : ""}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatNetworkCaptureStatus(result: NetworkCollectResult): string {
  const verified = result.artifacts.filter((item) => item.verified).length;
  const windowComplete = result.artifacts.filter((item) => item.windowComplete).length;
  const lines = [
    `[net] PCAP 回传校验：${verified}/${result.artifacts.length}`,
    `[net] 观测窗口：${windowComplete}/${result.artifacts.length} 覆盖到预期停止时刻`,
  ];
  for (const artifact of result.artifacts.filter((item) => !item.windowComplete)) {
    lines.push(`  - Pod ${artifact.pod}：${artifact.reason ?? "观测窗口提前结束"}`);
  }
  return `${lines.join("\n")}\n`;
}

export function isNetworkDebugPrerequisiteFailure(result: NetworkCollectResult): boolean {
  const requiredGaps = result.topology?.missing.filter((item) => item.required) ?? [];
  return !!result.topology
    && result.topology.targets.length === 0
    && result.artifacts.length === 0
    && requiredGaps.length > 0
    && requiredGaps.every((gap) =>
      !!gap.pod && gap.reason === NETWORK_DEBUG_ENVIRONMENT_MISSING_REASON
    );
}

export function formatNetworkDebugRecommendation(input: {
  profileName: string;
  namespace: string;
  services: readonly string[];
  kubeconfig?: string;
  context?: string;
  config?: string;
}): string {
  const command = formatDoctorDebugCommand(input);
  return [
    "[net] 所选 Service 的 Pod 均未准备抓包 environment，本次未开始抓包，也不生成失败 Evidence Bundle。",
    "[net] 推荐先执行：",
    `  ${command}`,
    "",
  ].join("\n");
}

export function formatNetworkCaptureScope(topology: NetworkTopology): string {
  const pods = new Set(topology.services.flatMap((service) => service.pods));
  const lines = [
    `[net] 本次抓包范围：${topology.services.length} 个 Service，${pods.size} 个 Running Pod`,
  ];
  for (const service of topology.services) {
    lines.push(
      `  - Service ${service.name}：`
      + (service.pods.length ? service.pods.join(", ") : "无 Running Pod"),
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeNetworkResult(
  bundle: EvidenceBundle,
  opts: CollectNetworkOptions,
  result: NetworkCollectResult,
  startedAt: string,
): void {
  const requiredMissing = result.topology?.missing.filter((item) => item.required) ?? [];
  const summary = [
    "# doctor net capture",
    "",
    `- session: ${opts.sessionId}`,
    `- capture mode: ${opts.capturePlan.mode}`,
    `- capture ID: ${opts.captureId}`,
    `- services: ${opts.services.join(", ")}`,
    `- target pods: ${result.topology?.targets.length ?? 0}`,
    `- verified PCAPs: ${result.artifacts.filter((item) => item.verified).length}/${result.artifacts.length}`,
    `- complete capture windows: ${result.artifacts.filter((item) => item.windowComplete).length}/${result.artifacts.length}`,
    `- trace IDs: ${result.traceIds.length ? result.traceIds.join(", ") : "not observed"}`,
    `- HTTP status: ${result.response?.response.statusCode ?? "not triggered"}`,
    `- response termination: ${result.response?.response.terminationReason ?? "not triggered"}`,
    `- required coverage gaps: ${requiredMissing.length}`,
    ...(result.reason ? [`- failure: ${result.reason}`] : []),
    "",
  ].join("\n");
  bundle.writeSummary(summary);
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      namespace: opts.namespace,
      services: opts.services,
      session_id: opts.sessionId,
      capture_id: opts.captureId,
      trace_ids: result.traceIds,
    },
    inspectionFacts: {
      topology: result.topology,
      capture_artifacts: result.artifacts.map((artifact) => ({
        pod: artifact.pod,
        services: artifact.services,
        debug_container: artifact.debugContainer,
        file: artifact.file,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        verified: artifact.verified,
        window_complete: artifact.windowComplete,
        reason: artifact.reason,
        metadata: artifact.metadata,
      })),
      response: result.response
        ? {
            status_code: result.response.response.statusCode,
            content_type: result.response.response.contentType,
            headers_file: result.response.response.headersFile,
            body_file: result.response.response.bodyFile,
            body_bytes: result.response.response.bodyBytes,
            response_ended_at: result.response.response.finishedAt,
            termination_reason: result.response.response.terminationReason,
          }
        : undefined,
    },
    params: {
      capture_mode: opts.capturePlan.mode,
      http_file: opts.capturePlan.mode === "tracking" ? basename(opts.capturePlan.requestFile) : undefined,
      timeout_seconds: opts.timeoutSeconds,
      drain_seconds: opts.drainSeconds,
      max_pcap_bytes_per_pod: opts.maxPcapBytes,
      max_response_bytes: opts.maxResponseBytes,
      filter: result.topology?.filter ?? opts.filter,
      cleanup_remote: opts.cleanupRemote,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

async function stopCaptures(
  armed: readonly ArmedCapture[],
  deps: NetworkCollectDependencies,
  bundle: EvidenceBundle,
  sessionId: string,
): Promise<void> {
  logNetworkStage(deps, `正在停止 ${armed.length} 个 Pod 的抓包…`);
  let stoppedCount = 0;
  await mapLimit(armed, CONTROL_CONCURRENCY, async ({ target, artifact }) => {
    const stopped = await deps.captureRuntime.stop(deps.executor, target.debug, sessionId);
    artifact.metadata = stopped.metadata ?? artifact.metadata;
    recordExec(
      bundle,
      `capture-stop-${target.pod}`,
      `停止 ${target.pod} 抓包`,
      stopped.result,
      "overhead",
      stopped.reason,
    );
    stoppedCount += 1;
    if (stopped.result.ok && !stopped.reason) {
      logNetworkStage(deps, `${target.pod}：抓包已停止（${stoppedCount}/${armed.length}）`);
    } else {
      logNetworkStage(
        deps,
        `${target.pod}：停止抓包失败（${stopped.reason ?? reason(stopped.result)}）`,
      );
    }
  });
}

async function collectCaptureFiles(
  armed: readonly ArmedCapture[],
  deps: NetworkCollectDependencies,
  bundle: EvidenceBundle,
  opts: CollectNetworkOptions,
): Promise<void> {
  logNetworkStage(deps, `正在读取 ${armed.length} 个 Pod 的抓包 metadata…`);
  const transfers = await mapLimit(
    armed,
    CONTROL_CONCURRENCY,
    async ({ target, artifact }): Promise<CaptureTransfer | undefined> => {
      const metadataResult = await deps.captureRuntime.metadata(
        deps.executor,
        target.debug,
        opts.sessionId,
      );
      recordExec(
        bundle,
        `capture-metadata-${target.pod}`,
        `读取 ${target.pod} 抓包 metadata`,
        metadataResult.result,
        "observe",
        metadataResult.reason,
      );
      const metadata = metadataResult.metadata ?? artifact.metadata;
      artifact.metadata = metadata;
      const podDir = join(opts.outputDir, "pods", target.pod);
      mkdirSync(podDir, { recursive: true, mode: 0o700 });
      if (metadata) {
        writeFileSync(
          join(podDir, "metadata.json"),
          `${JSON.stringify(metadata, null, 2)}\n`,
          { mode: 0o600 },
        );
      }
      const expectedBytes = metadata?.capture_bytes;
      const targetPath = metadata?.capture_file;
      if (
        !metadataResult.result.ok
        || !metadata
        || metadata.running
        || !targetPath
        || !expectedBytes
        || !metadata.capture_sha256
      ) {
        artifact.reason = metadataResult.reason
          ?? (metadata?.running
            ? "抓包仍在运行，无法取得稳定 PCAP"
            : "抓包 metadata 缺少 capture_file/capture_bytes/capture_sha256");
        bundle.addStep({
          id: `capture-fetch-${target.pod}`,
          title: `回传 ${target.pod} PCAP`,
          risk: "observe",
          status: "failed",
          reason: artifact.reason,
        });
        logNetworkStage(deps, `${target.pod}：抓包 metadata 不完整（${artifact.reason}）`);
        return undefined;
      }
      const hostPath = join(podDir, "capture.pcap");
      logNetworkStage(
        deps,
        `${target.pod}：待回传 ${formatProgressBytes(expectedBytes)} PCAP`,
      );
      return { target, artifact, metadata, expectedBytes, targetPath, hostPath };
    },
  );
  const candidates = transfers.filter(
    (item): item is CaptureTransfer => item !== undefined,
  );
  if (candidates.length === 0) {
    logNetworkStage(deps, "没有取得可回传的 PCAP metadata。");
    return;
  }

  const totalBytes = candidates.reduce((sum, item) => sum + item.expectedBytes, 0);
  const fetchedByPod = new Map<string, number>();
  let settled = 0;
  let verified = 0;
  logNetworkStage(
    deps,
    `开始回传并校验 ${candidates.length} 个 PCAP（合计 ${formatProgressBytes(totalBytes)}）…`,
  );
  deps.progress?.({
    label: "[net] 回传 PCAP",
    current: 0,
    total: totalBytes,
    detail: `0/${candidates.length} Pod 校验完成`,
  });

  await mapLimit(candidates, TRANSFER_CONCURRENCY, async ({
    target,
    artifact,
    metadata,
    expectedBytes,
    targetPath,
    hostPath,
  }) => {
    const fetched = await deps.downloadFromTarget({
      executor: deps.executor,
      target: target.debug,
      targetPath,
      hostPath,
      expectedBytes,
      onStart: (totalSlices) => logNetworkStage(
        deps,
        `${target.pod}：开始回传 ${formatProgressBytes(expectedBytes)}`
        + `（${totalSlices} 个分片）…`,
      ),
      onProgress: ({ slice, totalSlices, fetchedBytes }) => {
        fetchedByPod.set(target.pod, fetchedBytes);
        const current = [...fetchedByPod.values()].reduce((sum, bytes) => sum + bytes, 0);
        deps.progress?.({
          label: "[net] 回传 PCAP",
          current,
          total: totalBytes,
          detail: `${verified}/${candidates.length} Pod 校验完成 · `
            + `${target.pod} ${slice}/${totalSlices} 分片`,
        });
      },
      onRetry: (offset, attempt, retryReason) => logNetworkStage(
        deps,
        `${target.pod}：分片回传异常（offset=${offset}，${retryReason}），`
        + `正在第 ${attempt} 次尝试…`,
      ),
    });
    if (!fetched.ok) {
      fetchedByPod.set(target.pod, fetched.bytesWritten);
      artifact.reason = fetched.failure?.result.stderr.trim() || `PCAP 仅回传 ${fetched.bytesWritten}/${expectedBytes} bytes`;
      bundle.addStep({
        id: `capture-fetch-${target.pod}`,
        title: `回传 ${target.pod} PCAP`,
        risk: "observe",
        status: "failed",
        reason: artifact.reason,
        command: fetched.failure?.result.command,
        exitCode: fetched.failure?.result.exitCode,
        stderr: fetched.failure?.result.stderr,
      });
      logNetworkStage(deps, `${target.pod}：PCAP 回传失败（${artifact.reason}）`);
      settled += 1;
      return;
    }
    fetchedByPod.set(target.pod, expectedBytes);
    const digest = await sha256File(hostPath);
    if (digest !== metadata.capture_sha256) {
      artifact.reason = `PCAP SHA256 不一致：remote=${metadata.capture_sha256} local=${digest}`;
      bundle.addStep({
        id: `capture-fetch-${target.pod}`,
        title: `回传 ${target.pod} PCAP`,
        risk: "observe",
        status: "failed",
        reason: artifact.reason,
      });
      logNetworkStage(deps, `${target.pod}：PCAP 校验失败（${artifact.reason}）`);
      settled += 1;
      return;
    }
    artifact.file = `pods/${target.pod}/capture.pcap`;
    artifact.bytes = expectedBytes;
    artifact.sha256 = digest;
    artifact.verified = true;
    artifact.windowComplete = !["timeout", "size_limit"].includes(metadata.stop_reason ?? "");
    if (metadata.stop_reason === "size_limit") {
      artifact.reason = `达到每 Pod 容量上限 `
        + `${formatProgressBytes(metadata.max_bytes ?? expectedBytes)} 后提前停止；`
        + "已回传的 PCAP 仍可分析，但停止后的流量缺失";
    } else if (metadata.stop_reason === "timeout") {
      artifact.reason = `达到抓包时限 ${metadata.timeout_seconds ?? "unknown"} 秒后提前停止；`
        + "已回传的 PCAP 仍可分析，但停止后的流量缺失";
    } else {
      artifact.reason = undefined;
    }
    bundle.addStep({
      id: `capture-fetch-${target.pod}`,
      title: `回传 ${target.pod} PCAP`,
      risk: "observe",
      status: "ok",
      output: `bytes=${expectedBytes} sha256=${digest}`,
      durationMs: undefined,
    });
    settled += 1;
    verified += 1;
    logNetworkStage(
      deps,
      `${target.pod}：PCAP 回传并校验完成（${verified}/${candidates.length}）`,
    );
    if (opts.cleanupRemote && artifact.verified) {
      const cleaned = await deps.captureRuntime.cleanup(deps.executor, target.debug, opts.sessionId);
      recordExec(
        bundle,
        `capture-cleanup-${target.pod}`,
        `清理 ${target.pod} 远端抓包`,
        cleaned.result,
        "overhead",
        cleaned.reason,
      );
    }
  });
  const fetchedBytes = [...fetchedByPod.values()].reduce((sum, bytes) => sum + bytes, 0);
  deps.progress?.({
    label: "[net] 回传 PCAP",
    current: fetchedBytes,
    total: totalBytes,
    detail: `${verified}/${candidates.length} Pod 校验完成`,
    complete: true,
  });
  logNetworkStage(
    deps,
    `PCAP 回传阶段结束：${verified}/${candidates.length} 个校验完成，`
    + `${settled}/${candidates.length} 个已处理。`,
  );
}

export async function collectNetwork(
  opts: CollectNetworkOptions,
  deps: NetworkCollectDependencies,
): Promise<NetworkCollectResult> {
  const startedAt = new Date().toISOString();
  const captureMode = opts.capturePlan.mode;
  const bundle = new EvidenceBundle(opts.outputDir);
  const artifacts: NetworkCaptureArtifact[] = [];
  let topology;
  try {
    const inspected = await inspectNetworkTopology(
      deps.executor,
      opts.namespace,
      opts.services,
      opts.filter,
    );
    topology = inspected.topology;
    recordExec(bundle, "service-list", "目标 namespace Service 列表", inspected.captures.serviceResult);
    recordExec(bundle, "pod-list", "目标 namespace Pod 列表", inspected.captures.podResult);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    bundle.addStep({ id: "network-topology", title: "网络抓包目标解析", risk: "observe", status: "failed", reason: failure });
    const result = { code: 1, captureMode, artifacts, traceIds: [], reason: failure };
    writeNetworkResult(bundle, opts, result, startedAt);
    return result;
  }

  for (const gap of topology.missing) {
    bundle.addStep({
      id: `coverage-${gap.pod ?? gap.service ?? "unknown"}`,
      title: `网络抓包覆盖 ${gap.pod ?? gap.service ?? "unknown"}`,
      risk: "observe",
      status: gap.required ? "unavailable" : "skipped",
      reason: gap.reason,
    });
  }
  terminalStdout.info(formatNetworkCaptureScope(topology));
  const requiredGap = topology.missing.find((item) => item.required);
  if (requiredGap) {
    const result = { code: 1, captureMode, topology, artifacts, traceIds: [], reason: requiredGap.reason };
    writeNetworkResult(bundle, opts, result, startedAt);
    return result;
  }

  const ready = await mapLimit(topology.targets, CONTROL_CONCURRENCY, async (target) => {
    const readiness = await deps.captureRuntime.inspectReadiness(deps.executor, target.debug);
    recordExec(bundle, `capture-ready-${target.pod}`, `确认 ${target.pod} 抓包 environment`, readiness);
    return { target, readiness };
  });
  const unavailable = ready.find((item) => !item.readiness.ok);
  if (unavailable) {
    const result = {
      code: 1,
      captureMode,
      topology,
      artifacts,
      traceIds: [],
      reason: `${unavailable.target.pod} 抓包 environment 未就绪：${reason(unavailable.readiness)}`,
    };
    writeNetworkResult(bundle, opts, result, startedAt);
    return result;
  }
  if (opts.signal?.aborted) {
    const result = { code: 130, captureMode, topology, artifacts, traceIds: [], reason: "用户取消" };
    writeNetworkResult(bundle, opts, result, startedAt);
    return result;
  }

  const armed: ArmedCapture[] = [];
  await mapLimit(topology.targets, CONTROL_CONCURRENCY, async (target) => {
    const artifact: NetworkCaptureArtifact = {
      pod: target.pod,
      services: target.services,
      debugContainer: target.debug.container ?? "",
      verified: false,
      windowComplete: false,
    };
    artifacts.push(artifact);
    const started = await deps.captureRuntime.start(deps.executor, target.debug, {
      sessionId: opts.sessionId,
      timeoutSeconds: Math.ceil(opts.timeoutSeconds + opts.drainSeconds + 30),
      maxBytes: opts.maxPcapBytes,
      filter: topology.filter,
    });
    artifact.metadata = started.metadata;
    recordExec(
      bundle,
      `capture-start-${target.pod}`,
      `启动 ${target.pod} 抓包`,
      started.result,
      "overhead",
      started.reason ?? (started.metadata?.running ? undefined : "抓包控制器未进入 running"),
    );
    if (started.result.ok && started.metadata?.running) armed.push({ target, artifact });
    else artifact.reason = started.reason ?? "抓包控制器未进入 running";
  });

  const status = await mapLimit(armed, CONTROL_CONCURRENCY, async (capture) => {
    const checked = await deps.captureRuntime.status(deps.executor, capture.target.debug, opts.sessionId);
    capture.artifact.metadata = checked.metadata ?? capture.artifact.metadata;
    recordExec(
      bundle,
      `capture-armed-${capture.target.pod}`,
      `确认 ${capture.target.pod} 已 ARM`,
      checked.result,
      "observe",
      checked.reason ?? (checked.metadata?.running ? undefined : "抓包进程未运行"),
    );
    return checked.result.ok && checked.metadata?.running;
  });
  if (armed.length !== topology.targets.length || status.some((value) => !value)) {
    await stopCaptures(armed, deps, bundle, opts.sessionId);
    await collectCaptureFiles(armed, deps, bundle, opts);
    const result = {
      code: 1,
      captureMode,
      topology,
      artifacts,
      traceIds: [],
      reason: "并非所有目标 Pod 都成功进入 ARMED",
    };
    writeNetworkResult(bundle, opts, result, startedAt);
    return result;
  }
  if (opts.signal?.aborted) {
    await stopCaptures(armed, deps, bundle, opts.sessionId);
    await collectCaptureFiles(armed, deps, bundle, opts);
    const result = { code: 130, captureMode, topology, artifacts, traceIds: [], reason: "用户取消" };
    writeNetworkResult(bundle, opts, result, startedAt);
    return result;
  }

  const requestDir = join(opts.outputDir, "request");
  let response: HttpCapture | undefined;
  let modeFailure: string | undefined;
  let watchOutcome: "completed" | "cancelled" | "timeout" | undefined;
  const modeStartedAt = Date.now();
  try {
    if (opts.capturePlan.mode === "tracking") {
      mkdirSync(requestDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(requestDir, "request.yaml"), opts.capturePlan.requestSource, { mode: 0o600 });
      const requestPlan = injectCaptureHeader(opts.capturePlan.request, opts.captureId);
      writeFileSync(join(requestDir, "request-plan.json"), `${JSON.stringify({
        request_id: requestPlan.requestId,
        entrypoint_id: requestPlan.entrypointId,
        method: requestPlan.method,
        url: requestPlan.url,
        header_names: Object.keys(requestPlan.headers),
        body_bytes: requestPlan.body?.byteLength ?? 0,
        follow_redirects: requestPlan.followRedirects,
        timeout_ms: requestPlan.timeoutMs,
        max_response_bytes: requestPlan.maxResponseBytes,
      }, null, 2)}\n`, { mode: 0o600 });
      terminalStderr.error(`[net] 全部 ${armed.length} 个 Pod 已 ARM，开始染色请求 ${opts.captureId}\n`);
      response = await captureHttpResponse(requestPlan, 1, requestDir, "request", deps.sendHttp);
      bundle.addStep({
        id: "network-request",
        title: "执行染色 HTTP/SSE 请求",
        risk: "overhead",
        status: responseComplete(response) ? "ok" : "failed",
        reason: responseComplete(response)
          ? undefined
          : response.response.terminationReason,
        durationMs: response.response.durationMs,
        stderr: response.response.error,
      });
    } else {
      if (!deps.waitForWatchCompletion) throw new Error("守候模式缺少终端等待能力");
      terminalStdout.info(
        `[net] 全部 ${armed.length} 个 Pod 已 ARM，进入守候模式。\n`
        + "[net] 请完成页面操作，完成后回到此处按回车结束抓包。\n",
      );
      watchOutcome = await deps.waitForWatchCompletion({
        timeoutMs: opts.timeoutSeconds * 1000,
        signal: opts.signal,
      });
      const watchReason = watchOutcome === "timeout"
        ? `守候超过 ${opts.timeoutSeconds} 秒`
        : watchOutcome === "cancelled"
          ? "用户取消"
          : undefined;
      bundle.addStep({
        id: "network-watch",
        title: "守候用户操作窗口",
        risk: "overhead",
        status: watchOutcome === "completed" ? "ok" : "failed",
        reason: watchReason,
        durationMs: Date.now() - modeStartedAt,
      });
      modeFailure = watchReason;
      if (watchOutcome === "completed") {
        logNetworkStage(
          deps,
          "已收到页面操作完成信号，开始收尾；PCAP 分析将由 doctor neta 执行。",
        );
      }
    }
  } catch (error) {
    modeFailure = error instanceof Error ? error.message : String(error);
    bundle.addStep({
      id: opts.capturePlan.mode === "tracking" ? "network-request" : "network-watch",
      title: opts.capturePlan.mode === "tracking" ? "执行染色 HTTP/SSE 请求" : "守候用户操作窗口",
      risk: "overhead",
      status: "failed",
      reason: modeFailure,
    });
  } finally {
    if (!opts.signal?.aborted && watchOutcome !== "cancelled") {
      logNetworkStage(deps, `继续抓包 ${opts.drainSeconds} 秒，等待尾部流量落盘…`);
      await deps.sleep(opts.drainSeconds * 1000);
    }
    await stopCaptures(armed, deps, bundle, opts.sessionId);
  }

  await collectCaptureFiles(armed, deps, bundle, opts);
  const traceIds = opts.capturePlan.mode === "tracking" && response
    ? extractTraceIds(response, join(requestDir, "headers.txt"))
    : [];
  const modeComplete = opts.capturePlan.mode === "tracking"
    ? !modeFailure && responseComplete(response)
    : !modeFailure && watchOutcome === "completed";
  const complete = modeComplete && artifacts.every((item) => item.verified);
  const cancelled = opts.signal?.aborted || watchOutcome === "cancelled";
  const firstUnverifiedArtifact = artifacts.find((item) => !item.verified);
  const result: NetworkCollectResult = {
    code: complete ? 0 : cancelled ? 130 : 1,
    captureMode,
    topology,
    artifacts,
    traceIds,
    response,
    reason: modeFailure
      ?? (complete
        ? undefined
        : cancelled
          ? "用户取消"
          : firstUnverifiedArtifact?.reason ?? "触发窗口或 PCAP 采集不完整"),
  };
  writeNetworkResult(bundle, opts, result, startedAt);
  return result;
}

export async function runCollectNetwork(
  opts: CollectNetworkCliOpts,
  commandContext: CommandContext,
): Promise<number> {
  let timeoutSeconds: number;
  let drainSeconds: number;
  let maxPcapMiB: number;
  let maxResponseMiB: number;
  let capturePlan: CollectNetworkOptions["capturePlan"];
  try {
    timeoutSeconds = parsePositive(opts.timeout, "--timeout");
    drainSeconds = parsePositive(opts.drain, "--drain");
    maxPcapMiB = parsePositive(opts.maxPcapSize, "--max-pcap-size");
    maxResponseMiB = parsePositive(opts.maxResponseSize, "--max-response-size");
    const selectedFile = await resolveNetworkScenarioFile({ file: opts.file });
    if (selectedFile === undefined) return 130;
    if (selectedFile === null) {
      capturePlan = { mode: "watch" };
    } else {
      terminalStdout.info("[net] 模式：跟踪（doctor 按 YAML 发起并染色请求）\n");
      const requestSource = readFileSync(selectedFile, "utf-8");
      const scenario = loadHttpScenario(selectedFile, { timeoutSeconds, maxResponseMiB });
      const requests = scenario.requests.flatMap((group) => group.entrypoints);
      const selectedRequest = await resolveNetworkRequest(requests);
      if (!selectedRequest) return 130;
      capturePlan = {
        mode: "tracking",
        requestFile: selectedFile,
        requestSource,
        request: selectedRequest,
      };
    }
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const config = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!config) return 130;
  const executor = createKubernetesExecutor(config);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(access, {
    command: "doctor net",
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析本次抓包 Service 拓扑",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "解析每个 Service 的 Running Pod",
    }, {
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "控制 debug Container 内的短时抓包并回传 PCAP",
    }],
  });
  let services: string[];
  try {
    const selected = await resolveNetworkServiceScope({
      services: opts.services,
      namespace: config.kubernetes.namespace,
      kubeconfig: config.kubernetes.kubeconfig,
      context: config.kubernetes.context,
      loadChoices: () => listServiceChoices(executor, config.kubernetes.namespace),
    });
    if (!selected) return 130;
    services = selected;
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const now = new Date();
  const bundleName = defaultNetworkBundleName(now);
  const outputPath = resolveArchivePath(opts.output, bundleName);
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-net-"));
  const staging = join(stagingRoot, bundleName);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const abortController = new AbortController();
  const onInterrupt = () => abortController.abort();
  process.once("SIGINT", onInterrupt);
  const pcapProgress = new TerminalProgressLine({
    isTTY: !!process.stdout.isTTY,
    write: (text) => terminalStdout.write(text),
  });
  const log = (line: string) => {
    pcapProgress.interrupt();
    terminalStdout.info(`[net] ${line}\n`);
  };
  let result: NetworkCollectResult;
  try {
    result = await collectNetwork(
      {
      namespace: config.kubernetes.namespace,
      services,
      capturePlan,
      timeoutSeconds,
      drainSeconds,
      maxPcapBytes: Math.floor(maxPcapMiB * 1024 * 1024),
      maxResponseBytes: Math.floor(maxResponseMiB * 1024 * 1024),
      filter: opts.filter,
      cleanupRemote: !!opts.cleanupRemote,
      outputDir: staging,
      sessionId: `net-${token}`,
      captureId: `doctor-${token}`,
        signal: abortController.signal,
      },
      {
        executor,
        captureRuntime: infra.target.networkCapture,
        downloadFromTarget: infra.fileTransfer.downloadFromTarget,
        sleep,
        log,
        progress: (update) => pcapProgress.update(update),
        waitForWatchCompletion: async ({ timeoutMs, signal }) => {
          const outcome = await promptEnter({
            question: "页面操作完成后按回车结束抓包（q 取消）：",
            timeoutMs,
            signal,
          });
          return outcome === "submitted" ? "completed" : outcome;
        },
      },
    );
  } finally {
    pcapProgress.interrupt();
    process.removeListener("SIGINT", onInterrupt);
  }
  if (result.code !== 0) terminalStderr.error(formatNetworkFailureSummary(result));
  else if (result.artifacts.some((item) => !item.windowComplete)) {
    terminalStdout.warning(formatNetworkCaptureStatus(result));
  }
  if (isNetworkDebugPrerequisiteFailure(result)) {
    terminalStdout.info(formatNetworkDebugRecommendation({
      profileName: config.profileName,
      namespace: config.kubernetes.namespace,
      services,
      kubeconfig: opts.kubeconfig,
      context: opts.context,
      config: opts.config,
    }));
    rmSync(stagingRoot, { recursive: true, force: true });
    return result.code;
  }
  log(
    result.code === 0
      ? "正在打包 NetBundle；流量分析由 doctor neta 执行…"
      : "正在打包失败现场 Evidence Bundle…",
  );
  const delivery = result.code === 0
    ? { path: outputPath, packed: await packBundle(staging, outputPath) }
    : await deliverFailureBundle({
        bundleDir: staging,
        bundleName,
        requestedOutput: opts.output,
        collectCode: result.code,
        reason: result.reason,
      });
  if (!delivery.packed.ok) {
    terminalStderr.error(`[net] 打包失败，现场保留在: ${staging}\n`);
    return 1;
  }
  chmodSync(delivery.path, 0o600);
  rmSync(stagingRoot, { recursive: true, force: true });
  terminalStdout.result(
    result.code === 0,
    `[net] ${
      result.code === 0
        ? "NetBundle"
        : result.artifacts.some((item) => !!item.file)
          ? "不完整 NetBundle"
          : "失败 Evidence Bundle"
    }: ${delivery.path}\n`,
  );
  if (result.artifacts.some((item) => !!item.file)) {
    terminalStdout.info(`[net] 下一步：mono-doctor doctor neta "${delivery.path}"\n`);
  }
  return result.code;
}

export * from "./model";
export * from "./topology";
export * from "./analysis";

export const NETWORK_DEFAULTS = {
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  drainSeconds: DEFAULT_DRAIN_SECONDS,
  maxPcapMiB: DEFAULT_MAX_PCAP_MIB,
  maxResponseMiB: DEFAULT_MAX_RESPONSE_MIB,
} as const;
