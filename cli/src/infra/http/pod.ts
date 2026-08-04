import type { ExecResult, Executor, ExecTarget } from "../k8s/executor";
import { HttpTransportError } from ".";
import type {
  HttpTransportDiagnostics,
  HttpTransportRequest,
  HttpTransportResponse,
  SendHttp,
} from ".";
import type { HttpEndpointTarget, InspectHttpEndpoint } from "./connectivity";

interface HttpResponseHead {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
}

const HTTP_PREFIX = new TextEncoder().encode("HTTP/");
const TRANSPORT_MARKER = "doctor-http-transport:v1";
const CURL_DIAGNOSTICS_MIN_VERSION = [7, 63, 0] as const;

export function supportsPodCurlDiagnostics(versionOutput: string): boolean {
  const matched = /^curl\s+(\d+)\.(\d+)\.(\d+)/m.exec(versionOutput);
  if (!matched) return false;
  const actual = matched.slice(1).map(Number);
  for (let index = 0; index < CURL_DIAGNOSTICS_MIN_VERSION.length; index += 1) {
    if (actual[index]! > CURL_DIAGNOSTICS_MIN_VERSION[index]!) return true;
    if (actual[index]! < CURL_DIAGNOSTICS_MIN_VERSION[index]!) return false;
  }
  return true;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(new ArrayBuffer(left.byteLength + right.byteLength));
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function findSequence(input: Uint8Array, sequence: readonly number[]): number {
  for (let index = 0; index <= input.byteLength - sequence.length; index += 1) {
    if (sequence.every((value, offset) => input[index + offset] === value)) return index;
  }
  return -1;
}

function findHeaderEnd(input: Uint8Array): { index: number; length: number } | undefined {
  const crlf = findSequence(input, [13, 10, 13, 10]);
  const lf = findSequence(input, [10, 10]);
  if (crlf < 0 && lf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function couldStartHttpStatus(input: Uint8Array): boolean {
  const length = Math.min(input.byteLength, HTTP_PREFIX.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (input[index] !== HTTP_PREFIX[index]) return false;
  }
  return true;
}

function parseResponseHead(raw: Uint8Array): HttpResponseHead | undefined {
  const lines = new TextDecoder().decode(raw).split(/\r?\n/);
  const status = /^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/.exec(lines[0] ?? "");
  if (!status) return undefined;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return {
    statusCode: Number(status[1]),
    statusText: status[2] ?? "",
    headers,
  };
}

function execFailure(result: ExecResult, stderr = result.stderr): Error {
  const reason = stderr.trim().split("\n")[0]
    || (result.timedOut ? "kubectl exec timeout" : `curl exit=${result.exitCode ?? "unknown"}`);
  return new Error(`Pod 内 HTTP 请求失败：${reason}`);
}

function curlWriteOut(): string {
  return `%{stderr}\n${[
    TRANSPORT_MARKER,
    "%{remote_ip}",
    "%{remote_port}",
    "%{local_ip}",
    "%{local_port}",
    "%{time_namelookup}",
    "%{time_connect}",
    "%{time_appconnect}",
    "%{time_pretransfer}",
    "%{time_starttransfer}",
    "%{time_total}",
    "%{time_redirect}",
    "%{url_effective}",
    "%{num_redirects}",
    "%{http_version}",
    "%{ssl_verify_result}",
    "%{size_upload}",
    "%{size_download}",
  ].join("\t")}\n`;
}

export function buildPodCurlCommand(
  request: HttpTransportRequest,
  diagnostics = false,
): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil((request.timeoutMs ?? 30_000) / 1000));
  const command = [
    "curl",
    "--silent",
    "--show-error",
    "--include",
    "--no-buffer",
    "--compressed",
    "--max-time",
    String(timeoutSeconds),
  ];
  if (diagnostics) command.push("--write-out", curlWriteOut());
  if (request.followRedirects) command.push("--location");
  command.push("--request", request.method);
  for (const [name, value] of Object.entries(request.headers)) {
    command.push("--header", `${name}: ${value}`);
  }
  if (request.body !== undefined) command.push("--data-binary", "@-");
  command.push(request.url);
  return command;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function milliseconds(value: string | undefined): number | undefined {
  const seconds = parseNumber(value);
  return seconds === undefined ? undefined : Number((seconds * 1000).toFixed(3));
}

function positivePort(value: string | undefined): number | undefined {
  const port = parseNumber(value);
  return port !== undefined && port > 0 ? port : undefined;
}

function phaseDuration(end: number | undefined, start: number | undefined): number | undefined {
  return end !== undefined && start !== undefined ? Math.max(0, Number((end - start).toFixed(3))) : undefined;
}

function parsePodCurlDiagnostics(
  stderr: string,
  exitCode: number | null,
): { diagnostics?: HttpTransportDiagnostics; stderr: string } {
  const lines = stderr.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.startsWith(`${TRANSPORT_MARKER}\t`));
  if (markerIndex < 0) return { stderr };
  const fields = lines[markerIndex]!.split("\t");
  const cleanedStderr = lines.filter((_line, index) => index !== markerIndex).join("\n").trim();
  const nameLookup = milliseconds(fields[5]);
  const connect = milliseconds(fields[6]);
  const appConnect = milliseconds(fields[7]);
  const preTransfer = milliseconds(fields[8]);
  const startTransfer = milliseconds(fields[9]);
  const total = milliseconds(fields[10]);
  const finalUrl = fields[12] || undefined;
  const verifyResult = parseNumber(fields[15]);
  return {
    stderr: cleanedStderr,
    diagnostics: {
      engine: "curl",
      remoteAddress: fields[1] || undefined,
      remotePort: positivePort(fields[2]),
      localAddress: fields[3] || undefined,
      localPort: positivePort(fields[4]),
      finalUrl,
      redirectCount: parseNumber(fields[13]),
      httpVersion: fields[14] || undefined,
      timings: {
        dnsMs: nameLookup,
        tcpMs: phaseDuration(connect, nameLookup),
        tlsMs: appConnect && appConnect > 0 ? phaseDuration(appConnect, connect) : undefined,
        firstByteMs: phaseDuration(startTransfer, preTransfer),
        downloadMs: phaseDuration(total, startTransfer),
        redirectMs: milliseconds(fields[11]),
        totalMs: total,
      },
      tls: finalUrl?.startsWith("https:")
        ? { verifyResult }
        : undefined,
      exitCode: exitCode ?? undefined,
      error: cleanedStderr || undefined,
      uploadedBytes: parseNumber(fields[16]),
      downloadedBytes: parseNumber(fields[17]),
    },
  };
}

const CONNECTIVITY_MARKER = "doctor-connect:";

function endpointOrigin(endpoint: HttpEndpointTarget): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${endpoint.scheme}://${host}:${endpoint.port}/`;
}

export function buildPodEndpointInspectCommand(
  endpoint: HttpEndpointTarget,
  timeoutMs: number,
): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    "curl",
    "--silent",
    "--show-error",
    "--head",
    "--insecure",
    "--noproxy",
    "*",
    "--connect-timeout",
    String(timeoutSeconds),
    "--max-time",
    String(timeoutSeconds + 1),
    "--output",
    "/dev/null",
    "--write-out",
    `${CONNECTIVITY_MARKER}%{remote_ip}\t%{remote_port}\t%{time_connect}\n`,
    endpointOrigin(endpoint),
  ];
}

function podInspectionReason(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0]
    || `curl exit=${result.exitCode ?? "unknown"}`;
}

/**
 * Pod Inspect reuses the already-required curl binary. HEAD is sent only to the origin root,
 * without scenario headers/body; any HTTP status proves that DNS/TCP from this Container works.
 */
export function createPodHttpEndpointInspector(
  executor: Executor,
  target: ExecTarget,
): InspectHttpEndpoint {
  return async (endpoint, timeoutMs) => {
    const started = Date.now();
    const result = await executor.exec(target, buildPodEndpointInspectCommand(endpoint, timeoutMs), {
      timeoutMs: timeoutMs + 3_000,
    });
    const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith(CONNECTIVITY_MARKER));
    const [remoteAddress, _remotePort, connectSeconds] = marker
      ? marker.slice(CONNECTIVITY_MARKER.length).split("\t")
      : [];
    const connected = !!remoteAddress && Number(connectSeconds) > 0;
    if (result.ok || connected) {
      return {
        reachable: true,
        phase: "tcp",
        resolvedAddresses: remoteAddress ? [remoteAddress] : [],
        remoteAddress: remoteAddress || undefined,
        durationMs: Date.now() - started,
      };
    }
    const reason = podInspectionReason(result);
    return {
      reachable: false,
      phase: /could not resolve host|name or service not known|temporary failure in name resolution/i.test(reason)
        ? "dns"
        : "tcp",
      resolvedAddresses: [],
      durationMs: Date.now() - started,
      reason,
    };
  };
}

/**
 * 通过 kubectl exec 在指定 Container 内运行 curl；stdout 的 header 前缀在本机拆帧，
 * response body 保持流式进入 collect/http，因此容量限制和 SSE 观察仍由统一采集层负责。
 */
export function createPodHttpSender(
  executor: Executor,
  target: ExecTarget,
  diagnosticsEnabled = false,
): SendHttp {
  return (request, signal) => {
    const commandController = new AbortController();
    const abort = () => commandController.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        bodyCancelled = true;
        commandController.abort("response body cancelled");
      },
    });

    let resolveResponse!: (response: HttpTransportResponse) => void;
    let rejectResponse!: (error: Error) => void;
    let responseSettled = false;
    const response = new Promise<HttpTransportResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    let pending = new Uint8Array();
    let latestHead: HttpResponseHead | undefined;
    let bodyStarted = false;
    const diagnostics: HttpTransportDiagnostics | undefined = diagnosticsEnabled
      ? { engine: "curl", timings: {} }
      : undefined;

    const fail = (error: Error) => {
      if (!responseSettled) {
        responseSettled = true;
        rejectResponse(error);
      }
      if (!bodyCancelled) {
        try {
          bodyController.error(error);
        } catch {
          // Stream may already be closed by a concurrent process exit.
        }
      }
    };

    const startBody = (initial: Uint8Array) => {
      if (!latestHead || bodyStarted) return;
      bodyStarted = true;
      responseSettled = true;
      resolveResponse({ ...latestHead, body, diagnostics });
      if (initial.byteLength && !bodyCancelled) bodyController.enqueue(initial.slice());
      pending = new Uint8Array();
    };

    const consume = (chunk: Uint8Array) => {
      if (bodyStarted) {
        if (!bodyCancelled) bodyController.enqueue(chunk.slice());
        return;
      }
      pending = concatBytes(pending, chunk);
      while (!bodyStarted) {
        if (!couldStartHttpStatus(pending)) {
          if (latestHead) startBody(pending);
          else if (pending.byteLength >= HTTP_PREFIX.byteLength) {
            fail(new Error("Pod 内 curl 响应缺少 HTTP status line"));
          }
          return;
        }
        const end = findHeaderEnd(pending);
        if (!end) return;
        const parsed = parseResponseHead(pending.subarray(0, end.index));
        if (!parsed) {
          if (latestHead) startBody(pending);
          else fail(new Error("无法解析 Pod 内 curl 返回的 HTTP headers"));
          return;
        }
        latestHead = parsed;
        pending = pending.subarray(end.index + end.length).slice();
        if (!pending.byteLength) return;
      }
    };

    const timeoutMs = request.timeoutMs ?? 30_000;
    executor.exec(target, buildPodCurlCommand(request, diagnosticsEnabled), {
      stdin: request.body,
      timeoutMs: timeoutMs + 5_000,
      signal: commandController.signal,
      collectStdout: false,
      onStdoutBytes: consume,
    }).then((result) => {
      signal.removeEventListener("abort", abort);
      const parsed = parsePodCurlDiagnostics(result.stderr, result.exitCode);
      if (diagnostics && parsed.diagnostics) Object.assign(diagnostics, parsed.diagnostics);
      if (!bodyStarted && latestHead) startBody(pending);
      if (!result.ok) {
        const error = execFailure(result, parsed.stderr);
        fail(diagnostics ? new HttpTransportError(error.message, diagnostics, { cause: error }) : error);
        return;
      }
      if (!bodyStarted) {
        fail(new Error("Pod 内 curl 未返回可解析的 HTTP response"));
        return;
      }
      if (!bodyCancelled) bodyController.close();
    }, (error) => {
      signal.removeEventListener("abort", abort);
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    return response;
  };
}
