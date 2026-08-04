export interface HttpTransportTimingPhases {
  waitMs?: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  requestMs?: number;
  firstByteMs?: number;
  downloadMs?: number;
  redirectMs?: number;
  totalMs?: number;
}

export interface HttpTlsDiagnostics {
  protocol?: string;
  alpnProtocol?: string;
  cipher?: string;
  authorized?: boolean;
  authorizationError?: string;
  verifyResult?: number;
  peerCertificate?: {
    subject?: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    fingerprint256?: string;
  };
}

export interface HttpTransportDiagnostics {
  engine: "got" | "curl" | "fetch";
  remoteAddress?: string;
  remotePort?: number;
  localAddress?: string;
  localPort?: number;
  reusedSocket?: boolean;
  finalUrl?: string;
  redirectUrls?: readonly string[];
  redirectCount?: number;
  retryCount?: number;
  httpVersion?: string;
  timings: HttpTransportTimingPhases;
  tls?: HttpTlsDiagnostics;
  exitCode?: number;
  error?: string;
  uploadedBytes?: number;
  downloadedBytes?: number;
}

export interface HttpTransportResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  diagnostics?: HttpTransportDiagnostics;
}

export interface HttpServiceTarget {
  host: string;
  port: number;
}

export interface ServiceJsonRequest {
  label: string;
  path: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ServiceHttpResponse {
  ok: boolean;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  text: string;
  durationMs: number;
}

export interface ServiceHttpTransport {
  exchange(target: HttpServiceTarget, request: ServiceJsonRequest): Promise<ServiceHttpResponse>;
}

export interface ServiceHttpStreamingTransport extends ServiceHttpTransport {
  exchangeStream(
    target: HttpServiceTarget,
    request: ServiceJsonRequest,
    signal: AbortSignal,
  ): Promise<HttpTransportResponse>;
}

export interface ServiceJsonTransport {
  request(target: HttpServiceTarget, request: ServiceJsonRequest): Promise<unknown>;
}
