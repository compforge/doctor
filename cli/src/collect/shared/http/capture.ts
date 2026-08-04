import { mkdirSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HttpTransportError, sendHttpRequest } from "../../../infra/http";
import type { SendHttp } from "../../../infra/http";
import type { HttpTransportDiagnostics } from "../../../infra/http";
import type { HttpRequestPlan, HttpResponseObservation, HttpTerminationReason, SseResponseObservation } from "./model";
import { SseCaptureObserver } from "./sse-observation";

export type { SendHttp } from "../../../infra/http";

export interface HttpCapture {
  response: HttpResponseObservation;
  sse?: SseResponseObservation;
}

function responseExtension(contentType?: string): string {
  const normalized = contentType?.toLowerCase() ?? "";
  if (normalized.includes("text/event-stream")) return "sse";
  if (normalized.includes("application/json") || normalized.includes("+json")) return "json";
  if (normalized.startsWith("text/")) return "txt";
  return "bin";
}

function contentType(headers: Record<string, string>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1];
}

function serializeHeaders(statusCode: number, statusText: string, headers: Record<string, string>): string {
  const status = `HTTP ${statusCode}${statusText ? ` ${statusText}` : ""}`;
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `${[status, ...lines, ""].join("\n")}\n`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function captureHttpResponse(
  request: HttpRequestPlan,
  round: number,
  outputDir: string,
  relativeDir: string,
  sendHttp: SendHttp = sendHttpRequest,
  sseObserver?: SseCaptureObserver,
): Promise<HttpCapture> {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const headersFile = join(relativeDir, "headers.txt");
  const headersPath = join(outputDir, "headers.txt");
  writeFileSync(headersPath, "", { mode: 0o600 });

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  let statusCode: number | undefined;
  let responseContentType: string | undefined;
  let bodyBytes = 0;
  const bodyHash = createHash("sha256");
  let bodyFile = join(relativeDir, "body.bin");
  let error: string | undefined;
  let transportDiagnostics: HttpTransportDiagnostics | undefined;
  let terminationReason: HttpTerminationReason = "request_error";
  let sseCapture: ReturnType<SseCaptureObserver["finish"]> | undefined;

  try {
    const transport = await sendHttp({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      followRedirects: request.followRedirects,
      timeoutMs: request.timeoutMs,
    }, controller.signal);
    transportDiagnostics = transport.diagnostics;
    statusCode = transport.statusCode;
    responseContentType = contentType(transport.headers);
    writeFileSync(
      headersPath,
      serializeHeaders(transport.statusCode, transport.statusText, transport.headers),
      { mode: 0o600 },
    );

    const extension = responseExtension(responseContentType);
    bodyFile = join(relativeDir, `body.${extension}`);
    const bodyPath = join(outputDir, `body.${extension}`);
    const body = await open(bodyPath, "w", 0o600);
    const activeSseObserver = extension === "sse"
      ? sseObserver ?? new SseCaptureObserver()
      : undefined;
    try {
      const reader = transport.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = request.maxResponseBytes - bodyBytes;
          const accepted = value.byteLength <= remaining ? value : value.subarray(0, Math.max(remaining, 0));
          if (accepted.byteLength) {
            await body.write(accepted);
            bodyBytes += accepted.byteLength;
            bodyHash.update(accepted);
            // Date.now() 的毫秒粒度会把高吞吐流中的相邻 event 压成零间隔。
            const receivedAtMs = performance.timeOrigin + performance.now();
            activeSseObserver?.push(accepted, receivedAtMs);
          }
          if (accepted.byteLength !== value.byteLength) {
            terminationReason = "size_limit";
            await reader.cancel("doctor response size limit").catch(() => undefined);
            break;
          }
        }
      }
      if (terminationReason !== "size_limit") terminationReason = "response_complete";
      sseCapture = activeSseObserver?.finish();
    } finally {
      await body.close();
    }
  } catch (caught) {
    error = errorText(caught);
    if (caught instanceof HttpTransportError) transportDiagnostics = caught.diagnostics;
    terminationReason = timedOut ? "doctor_timeout" : statusCode === undefined ? "request_error" : "body_error";
    const bodyPath = join(outputDir, "body.bin");
    if (bodyFile.endsWith("body.bin")) writeFileSync(bodyPath, "", { mode: 0o600 });
    writeFileSync(join(outputDir, "error.txt"), `${error}\n`, { mode: 0o600 });
  } finally {
    clearTimeout(timer);
  }

  const finished = Date.now();
  const responseId = `http-response:${request.requestId}:${request.entrypointId}:${round}`;
  const response: HttpResponseObservation = {
    id: responseId,
    kind: "http-response",
    requestId: request.requestId,
    entrypointId: request.entrypointId,
    round,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    captureComplete: terminationReason === "response_complete",
    statusCode,
    contentType: responseContentType,
    bodyBytes,
    bodySha256: bodyHash.digest("hex"),
    headersFile,
    bodyFile,
    errorFile: error ? join(relativeDir, "error.txt") : undefined,
    error,
    terminationReason,
    transport: transportDiagnostics,
  };
  const sse: SseResponseObservation | undefined = sseCapture ? {
    id: `http-sse-response:${request.requestId}:${request.entrypointId}:${round}`,
    kind: "http-sse-response",
    requestId: request.requestId,
    entrypointId: request.entrypointId,
    round,
    bodyFile,
    ...sseCapture,
  } : undefined;
  return { response, sse };
}
