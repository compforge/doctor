import type {
  Diagnosis,
  Evidence,
  FindingMeta,
  ObservationMeta,
} from "../../protocol";
import type {
  NetworkFrameSummary,
  PacketAnalysisBackendName,
} from "../../../infra/host/network-analysis";
import type {
  HttpRequestEvidence,
  HttpResponseEvidence,
} from "../../shared/http/model";
import type { NetworkCaptureMode } from "../model";

export interface NetworkAnalysisConfig {
  mode: NetworkCaptureMode;
  timeoutMs: number;
}

export interface NetworkAnalysisServiceFact {
  name: string;
  clusterIp?: string;
  ports: number[];
  pods: string[];
}

export interface NetworkAnalysisPodFact {
  pod: string;
  podIp?: string;
  services: string[];
}

export interface NetworkAnalysisArtifactFact {
  pod: string;
  services: string[];
  file: string;
  sha256?: string;
  windowComplete: boolean;
  reason?: string;
}

export interface NetworkAnalysisFacts {
  sourceBundle: string;
  namespace?: string;
  requestedServices: string[];
  captureId?: string;
  traceIds: string[];
  identifiers: string[];
  startedAt?: string;
  finishedAt?: string;
  services: NetworkAnalysisServiceFact[];
  pods: NetworkAnalysisPodFact[];
  artifacts: NetworkAnalysisArtifactFact[];
  triggerResponse?: {
    statusCode?: number;
    contentType?: string;
    bodyBytes?: number;
    endedAt?: string;
    terminationReason?: string;
  };
}

export interface NetworkArtifactObservation extends ObservationMeta {
  kind: "network.capture-artifact";
  pod: string;
  services: string[];
  file: string;
  windowComplete: boolean;
  verified: boolean;
  decoded: boolean;
  decoder?: PacketAnalysisBackendName;
  frameCount: number;
  reason?: string;
}

export type NetworkHopTermination = "response" | "reset" | "finish" | "open";

export interface NetworkHopObservation extends ObservationMeta {
  kind: "network.http-hop";
  pod: string;
  observedAtServices: string[];
  stream: string;
  caller: string;
  callee: string;
  source: string;
  destination: string;
  method: string;
  host?: string;
  path: string;
  status?: number;
  startedAtEpoch?: number;
  responseAtEpoch?: number;
  durationMs?: number;
  termination: NetworkHopTermination;
  matchedIds: string[];
  request: HttpRequestEvidence;
  response?: HttpResponseEvidence;
  events: NetworkFrameSummary[];
}

export type NetworkObservation = NetworkArtifactObservation | NetworkHopObservation;
export type NetworkEvidence = Evidence<NetworkObservation, NetworkAnalysisFacts>;

export type NetworkFindingKind =
  | "network.http-error"
  | "network.connection-reset"
  | "network.response-missing";

export interface NetworkFinding extends FindingMeta<NetworkFindingKind> {
  message: string;
  service?: string;
  pod?: string;
  status?: number;
}

export type NetworkCoverageGoal =
  | "capture-scope"
  | "protocol-decoding"
  | "request-correlation"
  | "response-lifecycle";

export type NetworkDiagnosis = Diagnosis<
  NetworkEvidence,
  NetworkFinding,
  NetworkCoverageGoal
>;

export interface NetworkAnalysisDocument {
  schema: "doctor.net.analysis/v4";
  config: NetworkAnalysisConfig;
  analyzer: {
    decoder?: PacketAnalysisBackendName;
  };
  summary: {
    pcapCount: number;
    verifiedPcapCount: number;
    decodedPcapCount: number;
    matchedStreamCount: number;
    hopCount: number;
  };
  diagnosis: NetworkDiagnosis;
}
