import type {
  DiagnosisCoverage,
  Evidence,
  Fact,
  FindingMeta,
  ObservationMeta,
} from "../../protocol";
import type { HttpTransportDiagnostics } from "../../../infra/http";

export type HttpExecutionTarget =
  | { kind: "local" }
  | { kind: "pod"; namespace: string; pod: string; container: string };

export interface HttpEndpointTarget {
  key: string;
  scheme: "http" | "https";
  host: string;
  port: number;
  authority: string;
}

export interface HttpEndpointReference {
  requestId: string;
  entrypointId: string;
  url: string;
}

export interface HttpHeaderField {
  name: string;
  value: string;
}

export interface HttpBodyCapture {
  base64: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
}

export interface HttpRequestEvidence {
  observedAtEpoch?: number;
  scheme?: "http" | "https";
  method: string;
  authority?: string;
  path: string;
  httpVersion?: string;
  headers: HttpHeaderField[];
  body?: HttpBodyCapture;
}

export interface HttpResponseEvidence {
  observedAtEpoch?: number;
  status: number;
  reasonPhrase?: string;
  httpVersion?: string;
  headers: HttpHeaderField[];
  body?: HttpBodyCapture;
}

export interface HttpExchangeEvidence {
  id: string;
  label: string;
  request: HttpRequestEvidence;
  response?: HttpResponseEvidence;
  endedAtEpoch?: number;
  durationMs?: number;
  responseMissingReason?: string;
}

export interface HttpEndpointConnectivityFact {
  endpoint: HttpEndpointTarget;
  references: readonly HttpEndpointReference[];
  status: "reachable" | "unreachable" | "unknown";
  phase?: "dns" | "tcp";
  resolvedAddresses: readonly string[];
  remoteAddress?: string;
  durationMs: number;
  reason?: string;
}

export interface HttpInspectionFacts {
  execution: Fact<{ target: HttpExecutionTarget }, "http.execution">;
  endpoints: Fact<{ items: readonly HttpEndpointConnectivityFact[] }, "http.endpoints">;
}

export type HttpTerminationReason =
  | "response_complete"
  | "request_error"
  | "doctor_timeout"
  | "size_limit"
  | "body_error";

export interface HttpExpectation {
  status: readonly number[];
  contentType?: string;
  maxDurationMs?: number;
  sseTerminalEvent?: string;
}

export interface HttpRequestPlan {
  requestId: string;
  entrypointId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  followRedirects: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  expect: HttpExpectation;
}

export interface HttpComparisonPolicy {
  body: "none" | "exact";
  sseEvents: boolean;
}

export interface HttpRequestGroup {
  id: string;
  entrypoints: readonly HttpRequestPlan[];
  compare: HttpComparisonPolicy;
}

export interface HttpScenario {
  schema: "doctor-http/v1";
  name: string;
  requests: readonly HttpRequestGroup[];
}

export interface SseFrameSummary {
  receivedAt: string;
  event?: string;
  dataBytes: number;
  dataKind: "json" | "text" | "done";
  timestamp?: number;
  code?: string;
  traceId?: string;
  messageId?: string;
}

export interface SseTimelineSummary {
  firstFrameAt?: string;
  lastFrameAt?: string;
  durationMs?: number;
  p95GapMs?: number;
  maxGapMs?: number;
  terminalReceived: boolean;
}

export interface SseResponseObservation {
  id: string;
  kind: "http-sse-response";
  requestId: string;
  entrypointId: string;
  round: number;
  bodyFile: string;
  frameCount: number;
  jsonEventCount: number;
  incompleteFrame: boolean;
  frames: readonly SseFrameSummary[];
  timeline: SseTimelineSummary;
}

export interface HttpResponseObservation {
  id: string;
  kind: "http-response";
  requestId: string;
  entrypointId: string;
  round: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  captureComplete: boolean;
  statusCode?: number;
  contentType?: string;
  bodyBytes: number;
  bodySha256: string;
  headersFile: string;
  bodyFile: string;
  errorFile?: string;
  error?: string;
  terminationReason: HttpTerminationReason;
  transport?: HttpTransportDiagnostics;
}

export interface HttpAttemptObservation extends ObservationMeta {
  kind: "http-attempt";
  requestId: string;
  entrypointId: string;
  round: number;
  directory: string;
  response: HttpResponseObservation;
  sse?: SseResponseObservation;
}

export type HttpObservation = HttpResponseObservation | SseResponseObservation | HttpAttemptObservation;

export interface HttpEvidence extends Evidence<HttpAttemptObservation, HttpInspectionFacts> {
  requestGroups: readonly HttpRequestGroup[];
  repeat: number;
}

export interface HttpExecution {
  /** Top-level persisted Observation referenced by Findings derived from this attempt. */
  observationId: string;
  requestId: string;
  entrypointId: string;
  round: number;
  directory: string;
  response: HttpResponseObservation;
  sse?: SseResponseObservation;
  findings: readonly HttpFinding[];
  requestSuccess: boolean;
}

interface HttpAttemptFinding<Kind extends string> extends FindingMeta<Kind> {
  requestId: string;
  entrypointId: string;
  round: number;
}

export type HttpFinding =
  | (FindingMeta<"http.endpoint-unreachable"> & {
    endpoint: string;
    phase: "dns" | "tcp";
    reason: string;
    affectedRequests: readonly string[];
  })
  | (FindingMeta<"http.endpoint-inspection-unavailable"> & {
    endpoint: string;
    reason: string;
    affectedRequests: readonly string[];
  })
  | (HttpAttemptFinding<"http.transport-failed"> & {
    terminationReason: HttpTerminationReason;
    error?: string;
  })
  | (HttpAttemptFinding<"http.unexpected-status"> & {
    actual?: number;
    expected: readonly number[];
  })
  | (HttpAttemptFinding<"http.unexpected-content-type"> & {
    actual?: string;
    expected: string;
  })
  | (HttpAttemptFinding<"http.response-too-slow"> & {
    actualMs: number;
    expectedMaxMs: number;
  })
  | (HttpAttemptFinding<"http.sse-missing-terminal-event"> & {
    expectedEvent: string;
    lastEvent?: string;
  })
  | (HttpAttemptFinding<"http.sse-error-event"> & {
    code?: string;
    traceId?: string;
    messageId?: string;
  })
  | (HttpAttemptFinding<"http.sse-incomplete-frame">)
  | (FindingMeta<"http.intermittent-failure"> & {
    requestId: string;
    entrypointId: string;
    successful: number;
    failed: number;
  })
  | (FindingMeta<"http.entrypoint-response-mismatch"> & {
    requestId: string;
    round: number;
    outerEntrypoint: string;
    innerEntrypoint: string;
    differences: readonly string[];
  });

export interface HttpRequestSummary {
  requestId: string;
  entrypointId: string;
  total: number;
  successful: number;
  failed: number;
  successRate: number;
  durationMinMs: number;
  durationP50Ms: number;
  durationP95Ms: number;
  durationMaxMs: number;
  statusCounts: Record<string, number>;
}

export interface HttpExecutionDiagnosis {
  executions: readonly HttpExecution[];
  findings: readonly HttpFinding[];
  summaries: readonly HttpRequestSummary[];
}

export interface HttpDiagnosis extends HttpExecutionDiagnosis {
  facts: HttpInspectionFacts;
  observations: readonly HttpAttemptObservation[];
  coverage: readonly DiagnosisCoverage<HttpCoverageGoal>[];
}

export type HttpCoverageGoal = "endpoint-connectivity" | "http-response";
