import { closeSync, openSync, writeSync } from "node:fs";
import { KubeConfig } from "@kubernetes/client-node";
import { AbortController } from "abort-controller";
import fetch from "node-fetch";
import type { RequestInfo, RequestInit, Response } from "node-fetch";
import type { ExecResult } from "./executor";
import type {
  KubernetesPodLogAccess,
  PodLogRequest,
  PodLogResult,
  ServicePodListResult,
} from "./pod-log";

export interface ClientNodeLogPolicy {
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  maxAttempts: number;
}

export type ClientNodeFetch = (
  url: RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export const DEFAULT_CLIENT_NODE_LOG_POLICY: ClientNodeLogPolicy = {
  idleTimeoutMs: 15_000,
  hardTimeoutMs: 120_000,
  maxAttempts: 2,
};

export interface ClientNodePodLogOptions {
  namespace: string;
  kubeconfig?: string;
  context?: string;
  policy?: Partial<ClientNodeLogPolicy>;
  /** Transport seam for deterministic tests; production uses node-fetch. */
  fetchImpl?: ClientNodeFetch;
}

interface AttemptResult {
  ok: boolean;
  retryable: boolean;
  timedOut: boolean;
  error?: string;
  statusCode?: number;
  bytesRead: number;
  lastTimestamp?: string;
}

const RFC3339_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?:\s|$)/;
const RECENT_LINE_LIMIT = 256;

function parseSinceSeconds(value: string): number | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    "µs": 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
  };
  let seconds = 0;
  let cursor = 0;
  const segment = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gy;
  while (cursor < input.length) {
    segment.lastIndex = cursor;
    const match = segment.exec(input);
    if (!match) return undefined;
    seconds += Number(match[1]) * units[match[2]!]!;
    cursor = segment.lastIndex;
  }
  return Math.max(1, Math.ceil(seconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCommand(namespace: string, request: PodLogRequest): string[] {
  const command = [
    "kubernetes-api",
    "logs",
    "-n",
    namespace,
    request.pod,
  ];
  if (request.container) command.push("-c", request.container);
  if (request.previous) command.push("--previous");
  if (request.tail !== undefined) command.push(`--tail=${request.tail}`);
  if (request.limitBytes !== undefined) command.push(`--limit-bytes=${request.limitBytes}`);
  if (request.sinceTime) command.push(`--since-time=${request.sinceTime}`);
  else if (request.since) command.push(`--since=${request.since}`);
  return command;
}

/**
 * client-node 提供 kubeconfig/auth/TLS；Doctor 自己持有 fetch 的 AbortController，才能在
 * 响应头尚未返回时也执行 idle/hard timeout，并把已到手的字节保留为 partial evidence。
 */
class ClientNodeLogTransport {
  private readonly kubeConfig = new KubeConfig();
  private readonly policy: ClientNodeLogPolicy;
  private readonly initializationError?: string;

  constructor(private readonly options: ClientNodePodLogOptions) {
    this.policy = { ...DEFAULT_CLIENT_NODE_LOG_POLICY, ...options.policy };
    try {
      if (this.policy.idleTimeoutMs < 1 || this.policy.hardTimeoutMs < 1) {
        throw new Error("Pod Log timeout 必须为正数");
      }
      if (!Number.isInteger(this.policy.maxAttempts) || this.policy.maxAttempts < 1) {
        throw new Error("Pod Log maxAttempts 必须是正整数");
      }
      if (options.kubeconfig) this.kubeConfig.loadFromFile(options.kubeconfig);
      else this.kubeConfig.loadFromDefault();
      if (options.context) this.kubeConfig.setCurrentContext(options.context);
      if (!this.kubeConfig.getCurrentCluster()) {
        throw new Error(`kubeconfig context '${this.kubeConfig.getCurrentContext()}' 没有关联 cluster`);
      }
    } catch (error) {
      this.initializationError = errorMessage(error);
    }
  }

  async capture(request: PodLogRequest): Promise<PodLogResult> {
    const command = logCommand(this.options.namespace, request);
    const startedAt = Date.now();
    if (this.initializationError) {
      return this.unavailable(command, startedAt, `kubeconfig 初始化失败：${this.initializationError}`);
    }
    if (!request.container) {
      return this.unavailable(command, startedAt, "Kubernetes Pod Log API 要求指定 container");
    }
    const sinceSeconds = request.since && !request.sinceTime
      ? parseSinceSeconds(request.since)
      : undefined;
    if (request.since && !request.sinceTime && sinceSeconds === undefined) {
      return this.unavailable(command, startedAt, `无法解析日志时间窗口：${request.since}`);
    }

    const fd = request.rawFilePath ? openSync(request.rawFilePath, "w", 0o600) : undefined;
    const output: string[] = [];
    const recentLines: string[] = [];
    const recentLineSet = new Set<string>();
    const errors: string[] = [];
    let attempts = 0;
    let totalBytesRead = 0;
    let resumeSinceTime = request.sinceTime;
    let timedOut = false;
    let finalStatusCode: number | undefined;
    const hardDeadline = startedAt + this.policy.hardTimeoutMs;

    const emitLine = (line: string, deduplicate: boolean) => {
      if (deduplicate && recentLineSet.has(line)) return;
      const prefix = request.prefix ? `[pod/${request.pod}/${request.container}] ` : "";
      const rendered = `${prefix}${line}`;
      request.onLine?.(rendered);
      if (fd !== undefined) writeSync(fd, `${rendered}\n`);
      else output.push(rendered);
      recentLines.push(line);
      recentLineSet.add(line);
      if (recentLines.length > RECENT_LINE_LIMIT) {
        recentLineSet.delete(recentLines.shift()!);
      }
    };

    try {
      while (attempts < this.policy.maxAttempts) {
        const remainingHardTimeoutMs = hardDeadline - Date.now();
        if (remainingHardTimeoutMs <= 0) {
          timedOut = true;
          errors.push(`hard_timeout（hard=${this.policy.hardTimeoutMs}ms）`);
          break;
        }
        const remainingBytes = request.limitBytes === undefined
          ? undefined
          : Math.max(0, request.limitBytes - totalBytesRead);
        if (remainingBytes === 0) break;
        attempts += 1;
        const attempt = await this.captureAttempt({
          request: remainingBytes === undefined
            ? request
            : { ...request, limitBytes: remainingBytes },
          sinceSeconds,
          sinceTime: resumeSinceTime,
          hardTimeoutMs: remainingHardTimeoutMs,
          deduplicate: attempts > 1,
          emitLine,
        });
        totalBytesRead += attempt.bytesRead;
        timedOut ||= attempt.timedOut;
        finalStatusCode = attempt.statusCode;
        if (attempt.lastTimestamp) resumeSinceTime = attempt.lastTimestamp;
        if (attempt.ok) {
          const limited = request.limitBytes !== undefined
            && totalBytesRead >= request.limitBytes;
          return {
            ok: !limited,
            exitCode: limited ? null : 0,
            stdout: output.length ? `${output.join("\n")}\n` : "",
            stderr: limited ? `日志达到单次字节上限 ${request.limitBytes}` : "",
            durationMs: Date.now() - startedAt,
            timedOut,
            command,
            captureStatus: limited ? "partial" : "complete",
            reason: limited ? "byte_limit" : undefined,
            bytesRead: totalBytesRead,
            attempts,
          };
        }
        errors.push(attempt.error ?? "Kubernetes Pod Log API 请求失败");
        if (!attempt.retryable || attempts >= this.policy.maxAttempts) break;
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }

    const captureStatus = totalBytesRead > 0 ? "partial" : "unavailable";
    const byteLimitReached = request.limitBytes !== undefined
      && totalBytesRead >= request.limitBytes;
    if (byteLimitReached) errors.push(`日志达到单次字节上限 ${request.limitBytes}`);
    return {
      ok: false,
      exitCode: finalStatusCode ?? null,
      stdout: output.length ? `${output.join("\n")}\n` : "",
      stderr: errors.join("\n"),
      durationMs: Date.now() - startedAt,
      timedOut,
      command,
      captureStatus,
      reason: byteLimitReached ? "byte_limit" : timedOut ? "timeout" : "transport_error",
      bytesRead: totalBytesRead,
      attempts,
    };
  }

  private unavailable(command: string[], startedAt: number, reason: string): PodLogResult {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: reason,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      command,
      captureStatus: "unavailable",
      reason,
      bytesRead: 0,
      attempts: 0,
    };
  }

  private async captureAttempt(input: {
    request: PodLogRequest;
    sinceSeconds?: number;
    sinceTime?: string;
    hardTimeoutMs: number;
    deduplicate: boolean;
    emitLine: (line: string, deduplicate: boolean) => void;
  }): Promise<AttemptResult> {
    const cluster = this.kubeConfig.getCurrentCluster()!;
    const path = `/api/v1/namespaces/${encodeURIComponent(this.options.namespace)}`
      + `/pods/${encodeURIComponent(input.request.pod)}/log`;
    const url = new URL(path, cluster.server.endsWith("/") ? cluster.server : `${cluster.server}/`);
    url.searchParams.set("container", input.request.container!);
    url.searchParams.set("follow", "false");
    url.searchParams.set("timestamps", "true");
    if (input.request.previous) url.searchParams.set("previous", "true");
    if (input.request.tail !== undefined) url.searchParams.set("tailLines", String(input.request.tail));
    if (input.request.limitBytes !== undefined) {
      url.searchParams.set("limitBytes", String(input.request.limitBytes));
    }
    if (input.sinceTime) url.searchParams.set("sinceTime", input.sinceTime);
    else if (input.sinceSeconds !== undefined) {
      url.searchParams.set("sinceSeconds", String(input.sinceSeconds));
    }

    const controller = new AbortController();
    let abortReason: "idle_timeout" | "hard_timeout" | undefined;
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortReason = "idle_timeout";
        controller.abort();
      }, this.policy.idleTimeoutMs);
    };
    resetIdleTimer();
    const hardTimer = setTimeout(() => {
      abortReason = "hard_timeout";
      controller.abort();
    }, input.hardTimeoutMs);
    const decoder = new TextDecoder();
    let pending = "";
    let bytesRead = 0;
    let lastTimestamp: string | undefined;
    const consume = (text: string) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const timestamp = line.match(RFC3339_LINE)?.[1];
        if (timestamp) lastTimestamp = timestamp;
        input.emitLine(line, input.deduplicate);
      }
    };

    try {
      const init = await this.kubeConfig.applyToFetchOptions({});
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        ...init,
        method: "GET",
        // node-fetch v2 接受 abort-controller 的 signal；DOM 新版类型额外要求 reason/throwIfAborted。
        signal: controller.signal as never,
      });
      if (!response.ok) {
        const body = (await response.text()).trim().slice(0, 2_000);
        return {
          ok: false,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          timedOut: false,
          error: `Kubernetes Pod Log API HTTP ${response.status}${body ? `: ${body}` : ""}`,
          statusCode: response.status,
          bytesRead,
        };
      }
      if (!response.body) {
        return {
          ok: false,
          retryable: true,
          timedOut: false,
          error: "Kubernetes Pod Log API 返回空响应流",
          statusCode: response.status,
          bytesRead,
        };
      }
      // node-fetch v2 在 abort 时既让 async iterator reject，也向 Readable 发 error；
      // 显式监听避免 Bun 把同一个 AbortError 视为未处理异常。
      response.body.on("error", () => undefined);
      for await (const raw of response.body) {
        const chunk = raw instanceof Uint8Array ? raw : Buffer.from(raw);
        bytesRead += chunk.byteLength;
        resetIdleTimer();
        consume(decoder.decode(chunk, { stream: true }));
      }
      consume(decoder.decode());
      if (pending) {
        const timestamp = pending.match(RFC3339_LINE)?.[1];
        if (timestamp) lastTimestamp = timestamp;
        input.emitLine(pending, input.deduplicate);
      }
      if (abortReason) {
        return {
          ok: false,
          retryable: true,
          timedOut: true,
          error: `${abortReason}（idle=${this.policy.idleTimeoutMs}ms, hard=${this.policy.hardTimeoutMs}ms）`,
          statusCode: response.status,
          bytesRead,
          lastTimestamp,
        };
      }
      return {
        ok: true,
        retryable: false,
        timedOut: false,
        statusCode: response.status,
        bytesRead,
        lastTimestamp,
      };
    } catch (error) {
      const timedOut = abortReason !== undefined;
      return {
        ok: false,
        retryable: true,
        timedOut,
        error: timedOut
          ? `${abortReason}（idle=${this.policy.idleTimeoutMs}ms, hard=${this.policy.hardTimeoutMs}ms）`
          : errorMessage(error),
        bytesRead,
        lastTimestamp,
      };
    } finally {
      clearTimeout(idleTimer!);
      clearTimeout(hardTimer);
    }
  }
}

/**
 * 迁移期组合：Service/Pod 发现仍走既有 access，只有高体量 Pod Log transport 改为 API 流。
 * 调用侧不需要知道两种 transport；后续发现层 API 化时可直接替换 delegate。
 */
export class ClientNodePodLogAccess implements KubernetesPodLogAccess {
  private readonly transport: ClientNodeLogTransport;

  constructor(
    private readonly discovery: KubernetesPodLogAccess,
    options: ClientNodePodLogOptions,
  ) {
    this.transport = new ClientNodeLogTransport(options);
  }

  clientVersion(): Promise<ExecResult> {
    return this.discovery.clientVersion();
  }

  listServicePods(services: readonly string[]): Promise<ServicePodListResult> {
    return this.discovery.listServicePods(services);
  }

  collectPodLogs(request: PodLogRequest): Promise<PodLogResult> {
    return this.transport.capture(request);
  }
}
