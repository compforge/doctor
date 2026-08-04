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
  /** 指定后 stdout 原样流式写入该文件，返回值不再在内存中保留 stdout。 */
  rawFilePath?: string;
  onLine?: (line: string) => void;
}

/** Pod 枚举与日志读取能力；调用方决定采哪个 Pod，infra 决定如何通过 Kubernetes 采。 */
export interface KubernetesPodLogAccess {
  clientVersion(): Promise<ExecResult>;
  listServicePods(services: readonly string[]): Promise<ServicePodListResult>;
  collectPodLogs(request: PodLogRequest): Promise<ExecResult>;
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

  collectPodLogs(request: PodLogRequest) {
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
    if (request.sinceTime) args.push(`--since-time=${request.sinceTime}`);
    else if (request.since) args.push(`--since=${request.since}`);
    if (!request.rawFilePath && !request.onLine) {
      return this.executor.run(args, { timeoutMs: 60_000 });
    }

    const fd = request.rawFilePath
      ? openSync(request.rawFilePath, "w", 0o600)
      : undefined;
    let pending = "";
    const emitLines = (text: string) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) request.onLine?.(line);
    };
    return this.executor.run(args, {
      timeoutMs: 60_000,
      collectStdout: !request.rawFilePath,
      onStdoutBytes: fd === undefined ? undefined : (chunk) => writeSync(fd, chunk),
      onStdout: request.onLine ? emitLines : undefined,
    }).finally(() => {
      if (pending) request.onLine?.(pending);
      if (fd !== undefined) closeSync(fd);
    });
  }
}
