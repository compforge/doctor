import type {
  PrometheusQueryData,
  PrometheusRangeQueryData,
  PrometheusSuccessResponse,
} from "@compforge/prombed";
import type { MetricQuerySource } from "../model";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface RemoteMetricSourceOptions {
  url: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: MetricFetch;
}

export type MetricFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Prometheus-compatible HTTP API query source for existing remote storage. */
export class RemoteMetricSource implements MetricQuerySource {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #authorization?: string;
  readonly #fetch: MetricFetch;

  constructor(options: RemoteMetricSourceOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Remote metric URL 只支持 http:// 或 https://");
    }
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (this.#timeoutMs <= 0 || this.#maxResponseBytes <= 0) {
      throw new Error("Remote metric timeoutMs 和 maxResponseBytes 必须大于 0");
    }
    this.#fetch = options.fetch ?? fetch;
    if (options.username !== undefined || options.password !== undefined) {
      if (!options.username || !options.password) throw new Error("Remote metric username/password 必须成对配置");
      this.#authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    }
  }

  query(expression: string, timeMs = Date.now()): Promise<PrometheusSuccessResponse<PrometheusQueryData>> {
    return this.#request("/api/v1/query", {
      query: expression,
      time: String(timeMs / 1000),
    });
  }

  queryRange(
    expression: string,
    startMs: number,
    endMs: number,
    stepMs: number,
  ): Promise<PrometheusSuccessResponse<PrometheusRangeQueryData>> {
    return this.#request("/api/v1/query_range", {
      query: expression,
      start: String(startMs / 1000),
      end: String(endMs / 1000),
      step: String(stepMs / 1000),
    });
  }

  async #request<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Remote metric request timed out after ${this.#timeoutMs}ms`));
    }, this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        headers: this.#authorization ? { authorization: this.#authorization } : undefined,
        signal: controller.signal,
      });
      const text = await readBoundedText(response, this.#maxResponseBytes, controller.signal);
      if (!response.ok) throw new Error(`Remote metric HTTP ${response.status}: ${text.trim().slice(0, 300)}`);
      const payload = JSON.parse(text) as { status?: string; error?: string };
      if (payload.status !== "success") {
        throw new Error(`Remote metric query failed: ${payload.error ?? "unknown error"}`);
      }
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    throw new Error(`Remote metric 响应超过 ${limit} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const onAbort = () => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortReason(signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel("doctor remote metric response size limit").catch(() => undefined);
        throw new Error(`Remote metric 响应超过 ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Remote metric request aborted");
}
