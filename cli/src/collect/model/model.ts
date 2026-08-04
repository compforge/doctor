import type {
  Model,
  ModelBackend,
  ModelCatalog,
  ModelInference,
  ModelType,
} from "@compforge/doctor-plugin";
import type { TenantSummary } from "@compforge/doctor-plugin";
import type { KubernetesCommandInput } from "../../command/kubernetes-target";
import type { ServiceHttpResponse } from "../../infra/http";
import type { EvidenceBundle } from "../evidence";
import type {
  Diagnosis,
  Evidence,
  Fact,
  FindingMeta,
  ObservationMeta,
} from "../protocol";
import type { HttpCapture } from "../shared/http/capture";

export interface CollectModelCliOptions extends KubernetesCommandInput {
  tenantId?: string;
  tenantName?: string;
  model?: string;
  type?: string;
  timeout?: string;
  modelCatalogService?: string;
  modelCatalogPort?: string;
  tenantDirectoryService?: string;
  tenantDirectoryPort?: string;
  performance?: boolean;
  repeat?: string;
  maxOutputTokens?: string;
  output?: string;
  profileName?: string;
}

export interface ModelTestRequest {
  path: string;
  body: Record<string, unknown>;
}

export interface SelectedInferenceModel extends Model {
  type: Exclude<ModelType, "audio">;
  metaData: {
    apiBase: string;
    endpointId: string;
  };
}

export interface ModelTargetFact {
  tenant: Pick<TenantSummary, "id" | "name" | "displayName">;
  model: {
    id: string;
    name: string;
    type: SelectedInferenceModel["type"];
    provider: string;
    vendor?: string;
    version?: string;
    apiBase: string;
    endpointId: string;
  };
}

export interface ModelBackendFact {
  modelId: string;
  modelName: string;
  model: string;
  type: string;
  provider: string;
}

export interface ModelInspectionFacts {
  target: Fact<ModelTargetFact>;
  /** 只持久化 validation 所需 backend 的身份信息；credentials 留在运行上下文。 */
  backend: Fact<ModelBackendFact>;
}

export interface ModelDiagnosisConfig {
  performance?: boolean;
  repeat: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ModelInspectContext {
  catalog: ModelCatalog;
  backend?: ModelBackend;
}

export interface ModelCollectContext extends ModelInspectContext {
  inference: ModelInference;
  bundle: EvidenceBundle;
  staging: string;
  log: (line: string) => void;
}

export interface ModelResponseObservation extends ObservationMeta {
  id: "model-validation" | "model-inference";
  kind: "model-validation" | "model-inference";
  response?: ServiceHttpResponse;
  error?: string;
}

export interface ModelPerformanceDecisionObservation extends ObservationMeta {
  id: "model-performance-decision";
  kind: "model-performance-decision";
  enabled: boolean;
}

export interface ModelPerformanceWorkload {
  id: string;
  label: string;
  kind: "prefill" | "decode";
  promptCharacters: number;
  maxOutputTokens: number;
}

export interface ModelStreamSnapshot {
  semanticEventTimesMs: readonly number[];
  visibleOutputEventTimesMs: readonly number[];
  outputCharacters: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  finishReason?: string;
  streamError?: string;
}

export interface ModelPerformanceObservation extends ObservationMeta {
  id: string;
  kind: "model-performance";
  workload: ModelPerformanceWorkload;
  round: number;
  capture: HttpCapture;
  stream: ModelStreamSnapshot;
}

export type ModelObservation =
  | ModelResponseObservation
  | ModelPerformanceDecisionObservation
  | ModelPerformanceObservation;
export type ModelEvidence = Evidence<ModelObservation, ModelInspectionFacts>;

export type ModelFindingKind =
  | "model.validation-failed"
  | "model.inference-failed"
  | "model.performance-sample-failed"
  | "model.performance-token-metrics-unavailable"
  | "model.performance-icl-high"
  | "model.performance-intermittent";

export interface ModelFinding extends FindingMeta<ModelFindingKind> {
  summary: string;
  caseId?: string;
  round?: number;
  interChunkLatencyP95Ms?: number;
  interChunkLatencyMaxMs?: number;
  expectedMaxMs?: number;
}

export type ModelDiagnosisGoal = "validation" | "inference" | "performance";
export type ModelDiagnosis = Diagnosis<ModelEvidence, ModelFinding, ModelDiagnosisGoal>;
