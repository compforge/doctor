import { closeSync, openSync, writeSync } from "node:fs";
import type { ExecResult, Executor } from "./executor";
import {
  parsePods,
  type KubernetesPod,
} from "./pod";
import {
  findPodsForService,
  parseServices,
} from "./service";

export interface ServicePodListResult {
  serviceCapture: ExecResult;
  podCapture: ExecResult;
  byService: Record<string, string[]>;
  pods: KubernetesPod[];
  parseError?: string;
}

export interface PodLogRequest {
  pod: string;
  container?: string;
  allContainers?: boolean;
  prefix?: boolean;
  previous?: boolean;
  tail?: number;
  since?: string;
  sinceTime?: string;
  /** 单次 Container 日志响应的服务端字节上限。 */
  limitBytes?: number;
  /** 指定后 stdout 原样流式写入该文件，返回值不再在内存中保留 stdout。 */
  rawFilePath?: string;
  onLine?: (line: string) => void;
}

export type PodLogCaptureStatus = "complete" | "partial" | "unavailable";

export interface PodLogResult extends ExecResult {
  /** complete=完整读完；partial=保留了部分证据；unavailable=没有取得可用日志。 */
  captureStatus: PodLogCaptureStatus;
  reason?: string;
  bytesRead: number;
  attempts: number;
}

/** Pod 枚举与日志读取能力；调用方决定采哪个 Pod，infra 决定如何通过 Kubernetes 采。 */
export interface KubernetesPodLogAccess {
  clientVersion(): Promise<ExecResult>;
  listServicePods(services: readonly string[]): Promise<ServicePodListResult>;
  collectPodLogs(request: PodLogRequest): Promise<PodLogResult>;
}

export class KubectlPodLogAccess implements KubernetesPodLogAccess {
  constructor(
    private readonly executor: Executor,
    private readonly namespace: string,
  ) {}

  clientVersion() {
    return this.executor.run(["version", "--client"], { timeoutMs: 15_000 });
  }

  async listServicePods(services: readonly string[]): Promise<ServicePodListResult> {
    const [serviceCapture, podCapture] = await Promise.all([
      this.executor.run(["get", "services", "-o", "json"], { timeoutMs: 30_000 }),
      this.executor.run(["get", "pods", "-o", "json"], { timeoutMs: 30_000 }),
    ]);
    const empty = Object.fromEntries(services.map((service) => [service, []]));
    if (!serviceCapture.ok || !podCapture.ok) {
      return { serviceCapture, podCapture, byService: empty, pods: [] };
    }
    try {
      const availableServices = parseServices(serviceCapture.stdout, this.namespace);
      const pods = parsePods(podCapture.stdout, this.namespace);
      return {
        serviceCapture,
        podCapture,
        pods,
        byService: Object.fromEntries(services.map((service) => [
          service,
          findPodsForService(availableServices, pods, service, this.namespace).map((pod) => pod.name),
        ])),
      };
    } catch (err) {
      return {
        serviceCapture,
        podCapture,
        byService: empty,
        pods: [],
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async collectPodLogs(request: PodLogRequest): Promise<PodLogResult> {
    const args = [
      "logs",
      request.pod,
      "--timestamps=true",
    ];
    if (request.container) args.push("-c", request.container);
    if (request.allContainers) args.push("--all-containers=true");
    if (request.prefix) args.push("--prefix=true");
    if (request.previous) args.push("--previous");
    if (request.tail !== undefined) args.push(`--tail=${request.tail}`);
    if (request.limitBytes !== undefined) args.push(`--limit-bytes=${request.limitBytes}`);
    if (request.sinceTime) args.push(`--since-time=${request.sinceTime}`);
    else if (request.since) args.push(`--since=${request.since}`);
    if (!request.rawFilePath && !request.onLine) {
      const result = await this.executor.run(args, { timeoutMs: 60_000 });
      const bytesRead = Buffer.byteLength(result.stdout);
      return {
        ...result,
        captureStatus: result.ok ? "complete" : bytesRead ? "partial" : "unavailable",
        reason: result.ok ? undefined : result.stderr.trim() || `exit=${result.exitCode}`,
        bytesRead,
        attempts: 1,
      };
    }

    const fd = request.rawFilePath
      ? openSync(request.rawFilePath, "w", 0o600)
      : undefined;
    let pending = "";
    let bytesRead = 0;
    const emitLines = (text: string) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) request.onLine?.(line);
    };
    const result = await this.executor.run(args, {
      timeoutMs: 60_000,
      collectStdout: !request.rawFilePath,
      onStdoutBytes: (chunk) => {
        bytesRead += chunk.byteLength;
        if (fd !== undefined) writeSync(fd, chunk);
      },
      onStdout: request.onLine ? emitLines : undefined,
    }).finally(() => {
      if (pending) request.onLine?.(pending);
      if (fd !== undefined) closeSync(fd);
    });
    return {
      ...result,
      captureStatus: result.ok ? "complete" : bytesRead ? "partial" : "unavailable",
      reason: result.ok ? undefined : result.stderr.trim() || `exit=${result.exitCode}`,
      bytesRead,
      attempts: 1,
    };
  }
}
