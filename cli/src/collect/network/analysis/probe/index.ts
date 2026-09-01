import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Probe } from "../../../protocol";
import type {
  NetworkAnalysisInfra,
  NetworkFrameSummary,
  NetworkHttpBody,
} from "../../../../infra/host/network-analysis";
import type {
  NetworkAnalysisConfig,
  NetworkAnalysisFact,
  NetworkAnalysisFacts,
  NetworkArtifactObservation,
  NetworkHopObservation,
  NetworkObservation,
} from "../model";

export interface NetworkAnalysisProbeContext {
  bundleRoot: string;
  packetAnalysis: NetworkAnalysisInfra;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function streamKey(row: NetworkFrameSummary): string | undefined {
  if (row.tcpStream === undefined) return undefined;
  return `${row.pod}:${row.tcpStream}`;
}

function endpointAddress(endpoint: string): string {
  const separator = endpoint.lastIndexOf(":");
  return separator > 0 ? endpoint.slice(0, separator) : endpoint;
}

function serviceForEndpoint(endpoint: string, facts: NetworkAnalysisFact): string | undefined {
  const address = endpointAddress(endpoint);
  const pod = facts.pods.find((item) => item.podIp === address);
  if (pod?.services.length) return pod.services.join("+");
  return facts.services.find((item) => item.clusterIp === address)?.name;
}

function hopEndpointLabels(
  request: NetworkFrameSummary,
  facts: NetworkAnalysisFact,
): { caller: string; callee: string } {
  return {
    caller: serviceForEndpoint(request.source, facts) ?? request.source,
    callee: serviceForEndpoint(request.destination, facts) ?? request.host ?? request.destination,
  };
}

function terminalEvent(
  events: readonly NetworkFrameSummary[],
): NetworkFrameSummary | undefined {
  return events.find((event) =>
    event.kind === "response" || event.kind === "reset" || event.kind === "finish"
  );
}

function termination(event: NetworkFrameSummary | undefined): NetworkHopObservation["termination"] {
  if (!event) return "open";
  if (event.kind === "response") return "response";
  if (event.kind === "reset") return "reset";
  return "finish";
}

const MAX_HTTP_BODY_BYTES = 64 * 1024;

function messageBody(
  message: NetworkFrameSummary,
  events: readonly NetworkFrameSummary[],
): NetworkHttpBody | undefined {
  const bodies = [
    ...(message.body ? [message.body] : []),
    ...events.filter((event) =>
    event.kind === "body"
    && event.source === message.source
    && event.destination === message.destination
    && event.body
    ).map((event) => event.body!),
  ];
  if (!bodies.length) return undefined;
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  for (const body of bodies) {
    if (capturedBytes >= MAX_HTTP_BODY_BYTES) break;
    const bytes = Buffer.from(body.base64, "base64");
    const chunk = bytes.subarray(0, MAX_HTTP_BODY_BYTES - capturedBytes);
    chunks.push(chunk);
    capturedBytes += chunk.length;
  }
  const totalBytes = bodies.reduce((total, body) => total + body.totalBytes, 0);
  return {
    base64: Buffer.concat(chunks).toString("base64"),
    capturedBytes,
    totalBytes,
    truncated: bodies.some((body) => body.truncated) || capturedBytes < totalBytes,
  };
}

export function buildNetworkHopObservations(
  rows: readonly NetworkFrameSummary[],
  facts: NetworkAnalysisFact,
): NetworkHopObservation[] {
  const matchedStreams = new Set(
    rows.filter((row) =>
      facts.identifiers.length === 0 ? row.kind === "request" : row.matchedIds.length > 0
    )
      .map(streamKey)
      .filter((key): key is string => !!key),
  );
  const groups = new Map<string, NetworkFrameSummary[]>();
  for (const row of rows) {
    const key = streamKey(row);
    if (!key || !matchedStreams.has(key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const hops: NetworkHopObservation[] = [];
  for (const [stream, unsorted] of groups) {
    const events = [...unsorted].sort(
      (left, right) => (left.timeEpoch ?? 0) - (right.timeEpoch ?? 0),
    );
    const requests = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === "request");
    for (const [requestIndex, current] of requests.entries()) {
      const nextRequestIndex = requests[requestIndex + 1]?.index ?? events.length;
      // HTTP/2 请求会在同一 TCP 连接上交错；stream id 是应用层边界，RST/FIN 则仍作用于整条连接。
      const relatedEvents = current.event.http2Stream === undefined
        ? events.slice(current.index, nextRequestIndex)
        : events.slice(current.index).filter((event) =>
            event.http2Stream === current.event.http2Stream
            || event.kind === "reset"
            || event.kind === "finish"
          );
      const terminal = terminalEvent(relatedEvents.slice(1));
      const response = terminal?.kind === "response" ? terminal : undefined;
      const labels = hopEndpointLabels(current.event, facts);
      const startedAtEpoch = current.event.timeEpoch;
      const responseAtEpoch = terminal?.timeEpoch;
      const durationMs = startedAtEpoch !== undefined && responseAtEpoch !== undefined
        ? Math.max(0, (responseAtEpoch - startedAtEpoch) * 1000)
        : undefined;
      const observedPod = facts.pods.find((pod) => pod.pod === current.event.pod);
      const hopStream = current.event.http2Stream === undefined
        ? stream
        : `${stream}:h2-${current.event.http2Stream}`;
      hops.push({
        id: `network-hop:${hopStream}:${requestIndex + 1}`,
        kind: "network.http-hop",
        schemaVersion: 1,
        producer: { origin: "core", id: "network-pcap-analysis" },
        pod: current.event.pod,
        observedAtServices: observedPod?.services ?? [],
        stream: hopStream,
        caller: labels.caller,
        callee: labels.callee,
        source: current.event.source,
        destination: current.event.destination,
        method: current.event.method ?? "UNKNOWN",
        host: current.event.host,
        path: current.event.path ?? "/",
        status: terminal?.status,
        startedAtEpoch,
        responseAtEpoch,
        durationMs,
        termination: termination(terminal),
        matchedIds: [...new Set(relatedEvents.flatMap((event) => event.matchedIds))],
        request: {
          observedAtEpoch: current.event.timeEpoch,
          scheme: "http",
          method: current.event.method ?? "UNKNOWN",
          authority: current.event.host,
          path: current.event.path ?? "/",
          httpVersion: current.event.httpVersion,
          headers: current.event.headers,
          body: messageBody(current.event, relatedEvents),
        },
        response: response?.status === undefined
          ? undefined
          : {
              observedAtEpoch: response.timeEpoch,
              status: response.status,
              reasonPhrase: response.reasonPhrase,
              httpVersion: response.httpVersion,
              headers: response.headers,
              body: messageBody(response, relatedEvents),
            },
        events: relatedEvents,
      });
    }
  }
  return hops.sort(
    (left, right) => (left.startedAtEpoch ?? 0) - (right.startedAtEpoch ?? 0),
  );
}

function safeArtifactPath(root: string, relative: string): string | undefined {
  const absoluteRoot = resolve(root);
  const candidate = resolve(root, relative);
  return candidate.startsWith(`${absoluteRoot}${sep}`) ? candidate : undefined;
}

export const networkPcapProbe: Probe<
  NetworkObservation,
  NetworkAnalysisFacts,
  NetworkAnalysisConfig,
  NetworkAnalysisProbeContext
> = {
  id: "network-pcap-analysis",
  evaluate: (facts) => facts.bundle.artifacts.length
    ? { runnable: true }
    : { runnable: false, status: "unavailable", reason: "NetBundle 没有 PCAP artifact" },
  async run(ctx, facts, config) {
    const bundle = facts.bundle;
    const artifacts: NetworkArtifactObservation[] = [];
    const rows: NetworkFrameSummary[] = [];
    for (const artifact of bundle.artifacts) {
      const pcap = safeArtifactPath(ctx.bundleRoot, artifact.file);
      if (!pcap || !existsSync(pcap)) {
        artifacts.push({
          id: `network-artifact:${artifact.pod}`,
          kind: "network.capture-artifact",
          schemaVersion: 1,
          producer: { origin: "core", id: "network-pcap-analysis" },
          pod: artifact.pod,
          services: artifact.services,
          file: artifact.file,
          windowComplete: artifact.windowComplete,
          verified: false,
          decoded: false,
          frameCount: 0,
          reason: "PCAP 路径缺失或越界",
        });
        continue;
      }
      if (artifact.sha256 && await sha256File(pcap) !== artifact.sha256) {
        artifacts.push({
          id: `network-artifact:${artifact.pod}`,
          kind: "network.capture-artifact",
          schemaVersion: 1,
          producer: { origin: "core", id: "network-pcap-analysis" },
          pod: artifact.pod,
          services: artifact.services,
          file: artifact.file,
          windowComplete: artifact.windowComplete,
          verified: false,
          decoded: false,
          frameCount: 0,
          reason: "PCAP SHA256 校验失败",
        });
        continue;
      }
      try {
        const decoded = await ctx.packetAnalysis.decodePcap({
          pcap,
          pod: artifact.pod,
          identifiers: bundle.identifiers,
          timeoutMs: config.timeoutMs,
        });
        rows.push(...decoded.frames);
        artifacts.push({
          id: `network-artifact:${artifact.pod}`,
          kind: "network.capture-artifact",
          schemaVersion: 1,
          producer: { origin: "core", id: "network-pcap-analysis" },
          pod: artifact.pod,
          services: artifact.services,
          file: artifact.file,
          windowComplete: artifact.windowComplete,
          verified: true,
          decoded: true,
          decoder: decoded.backend,
          frameCount: decoded.frames.length,
          reason: artifact.reason,
        });
      } catch (error) {
        artifacts.push({
          id: `network-artifact:${artifact.pod}`,
          kind: "network.capture-artifact",
          schemaVersion: 1,
          producer: { origin: "core", id: "network-pcap-analysis" },
          pod: artifact.pod,
          services: artifact.services,
          file: artifact.file,
          windowComplete: artifact.windowComplete,
          verified: true,
          decoded: false,
          frameCount: 0,
          reason: `PCAP 解析失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return [...artifacts, ...buildNetworkHopObservations(rows, bundle)];
  },
};
