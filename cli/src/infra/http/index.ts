import { Agent as HttpAgent, type IncomingHttpHeaders } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type Socket } from "node:net";
import { Readable } from "node:stream";
import type { TLSSocket } from "node:tls";
import got, { type Method, type PlainResponse, type RequestError } from "got";
import type {
  HttpTlsDiagnostics,
  HttpTransportDiagnostics,
  HttpTransportResponse,
  HttpTransportTimingPhases,
} from "@compforge/doctor-plugin";

export interface HttpTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  followRedirects: boolean;
  timeoutMs?: number;
}

export type SendHttp = (
  request: HttpTransportRequest,
  signal: AbortSignal,
) => Promise<HttpTransportResponse>;

export type {
  HttpEndpointInspection,
  HttpEndpointTarget,
  InspectHttpEndpoint,
} from "./connectivity";
export { inspectLocalHttpEndpoint } from "./connectivity";

interface GotTimings {
  phases: {
    wait?: number;
    dns?: number;
    tcp?: number;
    tls?: number;
    request?: number;
    firstByte?: number;
    download?: number;
    total?: number;
  };
}

interface GotRequestState {
  socket?: Socket;
  reusedSocket?: boolean;
  redirectUrls?: readonly URL[];
  retryCount?: number;
  requestUrl?: URL;
  timings?: GotTimings;
}

function headersToRecord(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
  );
}

function timingPhases(timings?: GotTimings): HttpTransportTimingPhases {
  return {
    waitMs: timings?.phases.wait,
    dnsMs: timings?.phases.dns,
    tcpMs: timings?.phases.tcp,
    tlsMs: timings?.phases.tls,
    requestMs: timings?.phases.request,
    firstByteMs: timings?.phases.firstByte,
    downloadMs: timings?.phases.download,
    totalMs: timings?.phases.total,
  };
}

function tlsDiagnostics(socket?: Socket): HttpTlsDiagnostics | undefined {
  if (!socket || !("encrypted" in socket)) return undefined;
  const tlsSocket = socket as TLSSocket;
  const certificate = tlsSocket.getPeerCertificate();
  const cipher = tlsSocket.getCipher();
  const certificateName = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value.join(", ") : value;
  return {
    protocol: tlsSocket.getProtocol() ?? undefined,
    alpnProtocol: tlsSocket.alpnProtocol || undefined,
    cipher: cipher?.name,
    authorized: tlsSocket.authorized,
    authorizationError: tlsSocket.authorizationError?.message,
    peerCertificate: certificate && Object.keys(certificate).length
      ? {
          subject: certificateName(certificate.subject?.CN),
          issuer: certificateName(certificate.issuer?.CN),
          validFrom: certificate.valid_from,
          validTo: certificate.valid_to,
          fingerprint256: certificate.fingerprint256,
        }
      : undefined,
  };
}

function transportDiagnostics(
  state: GotRequestState,
  response?: PlainResponse,
): HttpTransportDiagnostics {
  const socket = response?.socket ?? state.socket;
  const finalUrl = response?.url ?? state.requestUrl?.toString();
  const finalHostname = finalUrl ? new URL(finalUrl).hostname : undefined;
  // Bun 的 node:http 兼容层当前可能返回占位 socket 地址；Got 的 timings 仍可用，
  // 地址则只接受 response.ip，或 URL 本身就是 IP 时使用该确定值。
  const socketAddressesReliable = process.versions.bun === undefined;
  return {
    engine: "got",
    remoteAddress: response?.ip
      ?? (socketAddressesReliable ? socket?.remoteAddress : undefined)
      ?? (finalHostname && isIP(finalHostname) ? finalHostname : undefined),
    remotePort: socketAddressesReliable ? socket?.remotePort : undefined,
    localAddress: socketAddressesReliable ? socket?.localAddress : undefined,
    localPort: socketAddressesReliable ? socket?.localPort : undefined,
    reusedSocket: socketAddressesReliable ? state.reusedSocket : undefined,
    finalUrl,
    redirectUrls: (response?.redirectUrls ?? state.redirectUrls ?? []).map((url) => url.toString()),
    redirectCount: (response?.redirectUrls ?? state.redirectUrls ?? []).length,
    retryCount: response?.retryCount ?? state.retryCount ?? 0,
    timings: timingPhases(response?.timings ?? state.timings),
    tls: tlsDiagnostics(socket),
  };
}

export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly diagnostics: HttpTransportDiagnostics,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HttpTransportError";
  }
}

/** 使用 Got 获取 Fetch 未暴露的 socket 与分阶段耗时，同时保持响应体流式落盘。 */
export async function sendHttpRequest(
  request: HttpTransportRequest,
  signal: AbortSignal,
): Promise<HttpTransportResponse> {
  // 诊断请求需要测到本轮真实的 DNS/TCP/TLS，不能复用连接池里的历史 socket。
  const agents = {
    http: new HttpAgent({ keepAlive: false }),
    https: new HttpsAgent({ keepAlive: false }),
  };
  const stream = got.stream(request.url, {
    method: request.method as Method,
    headers: request.headers,
    body: request.body,
    followRedirect: request.followRedirects,
    retry: { limit: 0 },
    cache: false,
    throwHttpErrors: false,
    signal,
    agent: agents,
  });
  stream.once("close", () => {
    agents.http.destroy();
    agents.https.destroy();
  });

  return await new Promise<HttpTransportResponse>((resolve, reject) => {
    let responseReceived = false;
    stream.once("response", (response: PlainResponse) => {
      responseReceived = true;
      const diagnostics = transportDiagnostics(stream, response);
      const refreshTimings = () => {
        Object.assign(diagnostics.timings, timingPhases(response.timings));
      };
      stream.once("end", refreshTimings);
      stream.once("error", refreshTimings);
      resolve({
        statusCode: response.statusCode,
        statusText: response.statusMessage ?? "",
        headers: headersToRecord(response.headers),
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        diagnostics,
      });
    });
    stream.once("error", (error: RequestError) => {
      if (responseReceived) return;
      reject(new HttpTransportError(
        error.message,
        transportDiagnostics(error.request ?? stream, error.response),
        { cause: error },
      ));
    });
  });
}

export type {
  HttpTlsDiagnostics,
  HttpTransportDiagnostics,
  HttpTransportResponse,
  HttpTransportTimingPhases,
  HttpServiceTarget,
  ServiceHttpResponse,
  ServiceHttpStreamingTransport,
  ServiceHttpTransport,
  ServiceJsonRequest,
  ServiceJsonTransport,
} from "@compforge/doctor-plugin";
export { KubernetesServiceJsonTransport } from "./service-json";
