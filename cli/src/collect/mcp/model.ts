import type { Diagnosis, Evidence, ObservationMeta } from "../protocol";
import type { McpJsonRpcMessage } from "../../infra/mcp";
import type { McpClient } from "../../infra/mcp";
import type { Executor } from "../../infra/k8s/executor";
import type { KubernetesPodLogAccess } from "../../infra/k8s/pod-log";
import type { CommandContext } from "../../command";
import type { ApprovalGate } from "../../command/approval";
import type { EvidenceBundle } from "../evidence";
import type {
  McpHttpRequestPlan,
  McpServerDefinition,
  McpToolDefinition,
} from "@compforge/doctor-plugin";
import type { McpFinding } from "./detector/types";

export interface HttpCapture {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  rawResponse: string;
  stderr: string;
  statusCode?: number;
  command: string[];
}

export interface McpFacts {
  traceId: string;
  target: {
    server: McpServerDefinition;
    tool: McpToolDefinition;
    argumentNames: readonly string[];
  };
  configuredTools: readonly string[];
  runtimeTools: readonly string[];
  runtimeToolsError?: string;
  gatewayPods: readonly string[];
  httpPlan?: McpHttpRequestPlan;
  httpCurl?: string;
}

export interface McpDiagnosisConfig {
  timeoutMs: number;
  args: Record<string, unknown>;
}

export interface McpCommandContext {
  command: CommandContext;
  config: McpDiagnosisConfig;
  executor: Executor;
  podLogs: KubernetesPodLogAccess;
  bundle: EvidenceBundle;
  client?: McpClient;
  approve: ApprovalGate;
  startedAt: string;
  traceId: string;
  requiredEvidence: Set<string>;
  writeArtifact: (name: string, content: string) => string;
}

export interface McpCallObservation extends ObservationMeta {
  id: "mcp-call";
  kind: "mcp-call";
  ok: boolean;
  durationMs: number;
  response?: McpJsonRpcMessage;
  error?: string;
}

export interface HttpCallObservation extends ObservationMeta {
  id: "http-call";
  kind: "http-call";
  ok: boolean;
  capture: HttpCapture;
}

export interface GatewayLogsObservation extends ObservationMeta {
  id: "gateway-logs";
  kind: "gateway-logs";
  ok: boolean;
  matchedLines: number;
  reason?: string;
}

export type McpObservation = McpCallObservation | HttpCallObservation | GatewayLogsObservation;
export type McpEvidence = Evidence<McpObservation, McpFacts>;
export type McpDiagnosisGoal = "mcp-call" | "http-comparison" | "gateway-logs";
export type McpDiagnosis = Diagnosis<McpEvidence, McpFinding, McpDiagnosisGoal>;

export function buildMcpEvidence(
  observations: readonly McpObservation[],
  facts: McpFacts,
): McpEvidence {
  return { observations, facts };
}

export function mcpCallObservation(evidence: McpEvidence): McpCallObservation | undefined {
  return evidence.observations.find(
    (item): item is McpCallObservation => item.kind === "mcp-call",
  );
}

export function httpCallObservation(evidence: McpEvidence): HttpCallObservation | undefined {
  return evidence.observations.find(
    (item): item is HttpCallObservation => item.kind === "http-call",
  );
}

export function gatewayLogsObservation(evidence: McpEvidence): GatewayLogsObservation | undefined {
  return evidence.observations.find(
    (item): item is GatewayLogsObservation => item.kind === "gateway-logs",
  );
}
