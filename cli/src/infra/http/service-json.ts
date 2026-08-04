import type { Executor, KubectlOptions } from "../k8s/executor";
import { ServicePortForwarder } from "../k8s/service-port-forward";
import type {
  HttpServiceTarget,
  HttpTransportResponse,
  ServiceHttpResponse,
  ServiceHttpStreamingTransport,
  ServiceJsonRequest,
  ServiceJsonTransport,
} from "@compforge/doctor-plugin";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * 为集群内 HTTP Service 提供有界 JSON 请求，并统一持有 port-forward 生命周期。
 * 业务 client 只描述 endpoint 与协议，不依赖 Kubernetes 实现。
 */
export class KubernetesServiceJsonTransport implements
  ServiceJsonTransport,
  ServiceHttpStreamingTransport
{
  private forwarder?: ServicePortForwarder;

  constructor(
    private readonly executor: Executor,
    private readonly kube: KubectlOptions & { namespace: string },
  ) {}

  async exchange(target: HttpServiceTarget, request: ServiceJsonRequest): Promise<ServiceHttpResponse> {
    this.forwarder ??= await ServicePortForwarder.create(this.executor, this.kube);
    const endpoint = await this.forwarder.forward(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const response = await fetch(`http://${endpoint.host}:${endpoint.port}${request.path}`, {
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const responseLimit = request.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
      if (Buffer.byteLength(text, "utf-8") > responseLimit) {
        throw new Error(`${request.label} 响应超过 ${responseLimit} bytes`);
      }
      return {
        ok: response.ok,
        statusCode: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        text,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async request(target: HttpServiceTarget, request: ServiceJsonRequest): Promise<unknown> {
    const response = await this.exchange(target, request);
    if (!response.ok) {
      const detail = response.text.trim().split("\n")[0];
      throw new Error(
        `${request.label} HTTP ${response.statusCode}${detail ? `: ${detail}` : ""}`,
      );
    }
    try {
      return JSON.parse(response.text) as unknown;
    } catch (error) {
      throw new Error(
        `${request.label} 返回非 JSON 响应：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async exchangeStream(
    target: HttpServiceTarget,
    request: ServiceJsonRequest,
    signal: AbortSignal,
  ): Promise<HttpTransportResponse> {
    this.forwarder ??= await ServicePortForwarder.create(this.executor, this.kube);
    const endpoint = await this.forwarder.forward(target);
    const logicalUrl = `http://${target.host}:${target.port}${request.path}`;
    const startedAt = Date.now();
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}${request.path}`, {
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal,
    });
    return {
      statusCode: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body,
      diagnostics: {
        engine: "fetch",
        finalUrl: logicalUrl,
        timings: {
          firstByteMs: Date.now() - startedAt,
        },
      },
    };
  }

  close(): void {
    this.forwarder?.stop();
    this.forwarder = undefined;
  }
}
