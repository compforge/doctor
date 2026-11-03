import { evidenceGaps, type EvidenceGapFinding } from "../../../evidence-gaps";
import type {
  Detector,
  } from "../../../protocol";
import type {
  NetworkAnalysisConfig,
  NetworkArtifactObservation,
  NetworkEvidence,
  NetworkFinding,
  NetworkHopObservation,
  NetworkObservation,
} from "../model";

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "network-http-analysis" },
};

export function buildNetworkEvidence(
  observations: readonly NetworkObservation[],
  facts: NetworkEvidence["facts"],
): NetworkEvidence {
  return { observations, facts };
}

export function networkArtifactObservations(
  evidence: NetworkEvidence,
): NetworkArtifactObservation[] {
  return evidence.observations.filter(
    (item): item is NetworkArtifactObservation => item.kind === "network.capture-artifact",
  );
}

export function networkHopObservations(
  evidence: NetworkEvidence,
): NetworkHopObservation[] {
  return evidence.observations.filter(
    (item): item is NetworkHopObservation => item.kind === "network.http-hop",
  );
}

function logicalHopKey(hop: NetworkHopObservation): string {
  return `${hop.callee}\u0000${hop.method}\u0000${hop.path}\u0000${hop.status ?? ""}`;
}

function groupHops(
  hops: readonly NetworkHopObservation[],
): NetworkHopObservation[][] {
  const grouped = new Map<string, NetworkHopObservation[]>();
  for (const hop of hops) {
    const key = logicalHopKey(hop);
    grouped.set(key, [...(grouped.get(key) ?? []), hop]);
  }
  return [...grouped.values()];
}

const detectHttpErrors: Detector<NetworkEvidence, NetworkFinding> = (evidence) =>
  groupHops(networkHopObservations(evidence).filter((hop) => (hop.status ?? 0) >= 400))
    .map((observations) => {
      const hop = observations[0]!;
      return {
        ...FINDING_META,
        id: `network-http-error:${hop.callee}:${hop.status}:${hop.method}:${hop.path}`,
        kind: "network.http-error",
        severity: "warning",
        confidence: "high",
        service: hop.callee,
        pod: hop.pod,
        status: hop.status,
        message: `${hop.callee} 的 ${hop.method} ${hop.path} 在报文中返回 HTTP ${hop.status}`,
        evidence: observations.map((item) => ({
          observationId: item.id,
          role: "supporting" as const,
        })),
      };
    });

const detectResets: Detector<NetworkEvidence, NetworkFinding> = (evidence) =>
  groupHops(networkHopObservations(evidence).filter((hop) =>
    hop.events.some((event) => event.kind === "reset")
  ))
    .map((observations) => {
      const hop = observations[0]!;
      return {
        ...FINDING_META,
        id: `network-reset:${hop.callee}:${hop.method}:${hop.path}`,
        kind: "network.connection-reset",
        severity: "warning",
        confidence: "high",
        service: hop.callee,
        pod: hop.pod,
        message: `${hop.caller} → ${hop.callee} 的 ${hop.method} ${hop.path} 在响应完成前出现 TCP RST`,
        evidence: observations.map((item) => ({
          observationId: item.id,
          role: "supporting" as const,
        })),
      };
    });

const detectMissingResponses: Detector<NetworkEvidence, NetworkFinding> = (evidence) =>
  groupHops(networkHopObservations(evidence).filter((hop) => hop.termination === "open"))
    .map((observations) => {
      const hop = observations[0]!;
      return {
        ...FINDING_META,
        id: `network-response-missing:${hop.callee}:${hop.method}:${hop.path}`,
        kind: "network.response-missing",
        severity: "warning",
        confidence: "medium",
        service: hop.callee,
        pod: hop.pod,
        message: `${hop.caller} → ${hop.callee} 已观察到 ${hop.method} ${hop.path}，但抓包窗口内未重建出响应或连接终止`,
        evidence: observations.map((item) => ({
          observationId: item.id,
          role: "supporting" as const,
        })),
      };
    });

export const networkDetectors: readonly Detector<NetworkEvidence, NetworkFinding>[] = [
  detectHttpErrors,
  detectResets,
  detectMissingResponses,
];

export function detectNetworkEvidenceGaps(
  evidence: NetworkEvidence,
  config: NetworkAnalysisConfig,
): EvidenceGapFinding[] {
  const artifacts = networkArtifactObservations(evidence);
  const hops = networkHopObservations(evidence);
  return [
    ...evidenceGaps("capture-scope", artifacts
        .filter((item) => !item.windowComplete || !item.verified)
        .map((item) => `${item.pod}: ${item.reason ?? "PCAP 不完整或校验失败"}`), evidence),
    ...evidenceGaps("protocol-decoding", artifacts
        .filter((item) => !item.decoded)
        .map((item) => `${item.pod}: ${item.reason ?? "PCAP 未解码"}`), evidence),
    ...evidenceGaps("request-correlation", hops.length > 0
        ? []
        : [
            config.mode === "watch"
              ? "守候窗口内未重建出可见 HTTP 请求；可能存在 TLS、操作未命中抓包范围或协议覆盖缺口"
              : "未在可解码 HTTP Header 中找到 capture ID / trace ID；可能存在 TLS、标识未透传或协议覆盖缺口",
          ], evidence),
    ...evidenceGaps("response-lifecycle", hops
        .filter((item) => item.termination === "open")
        .map((item) => `${item.caller} → ${item.callee} ${item.method} ${item.path}: 未观察到响应终态`), evidence),
  ];
}
