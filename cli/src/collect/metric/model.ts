import type { ServiceMetricChart, ServiceMetricDetector } from "@compforge/doctor-plugin";
import type {
  EmbeddedMetricSource,
  MetricQuerySource,
  RemoteMetricSourceOptions,
} from "../../infra/metric";
import type { EvidenceBundle } from "../evidence";
import type {
  Diagnosis,
  Evidence,
  Fact,
  FindingMeta,
  ObservationMeta,
} from "../protocol";

export interface CollectMetricCliOpts {
  services?: string;
  watch?: string;
  interval?: string;
  prometheus?: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

export type MetricWatch =
  | { mode: "snapshot"; label: "0" }
  | { mode: "duration"; label: string; durationMs: number }
  | { mode: "until-interrupt"; label: "Ctrl+C" };

export interface MetricConfig {
  services: string[];
  servicesExplicit: boolean;
  watch: MetricWatch;
  intervalMs: number;
  profileName: string;
  prometheus?: RemoteMetricSourceOptions;
  /** Remote Service metrics remain usable when optional Kubernetes Store sampling cannot be prepared. */
  storeSupplementUnavailableReason?: string;
  namespace: string;
  namespaceSource: string;
  kube: { namespace: string; kubeconfig?: string; context?: string };
  reportName: string;
  outputPath: string;
}

export interface MetricSeries {
  labels: Record<string, string>;
  points: Array<{ timestamp: number; value: number }>;
}

export type MetricSourceKind = "remote" | "embedded" | "hybrid";

export interface MetricInspectionFacts {
  source: Fact<{
    kind: MetricSourceKind;
    backend: string;
    targetCount: number;
  }>;
}

export interface MetricWindowObservation extends ObservationMeta {
  kind: "metric-window";
  source: MetricSourceKind;
  startedAt: number;
  finishedAt: number;
  scrapeErrors: string[];
}

export type MetricQueryConsumer =
  | { kind: "chart"; definition: ServiceMetricChart }
  | { kind: "detector"; definition: ServiceMetricDetector };

export interface MetricQueryObservation extends ObservationMeta {
  kind: "metric-query";
  service: string;
  queryKind: "instant" | "range";
  expression: string;
  consumers: MetricQueryConsumer[];
  status: "collected" | "empty" | "failed";
  series: MetricSeries[];
  error?: string;
}

export type MetricObservation = MetricWindowObservation | MetricQueryObservation;

export type MetricEvidence = Evidence<MetricObservation, MetricInspectionFacts>;

export interface MetricFinding extends FindingMeta<"metric.threshold-exceeded"> {
  kind: "metric.threshold-exceeded";
  service: string;
  title: string;
  message: string;
  value: number;
  threshold: number;
}

export type MetricDiagnosisGoal = `metric:${string}:${"chart" | "detector"}:${string}`;
export type MetricDiagnosis = Diagnosis<MetricEvidence, MetricFinding, MetricDiagnosisGoal>;

export interface MetricQueryPlan {
  id: string;
  queryKind: "instant" | "range";
  expression: string;
  consumers: MetricQueryConsumer[];
}

export interface MetricCollectContext {
  source: MetricQuerySource;
  storeSource?: MetricQuerySource;
  sourceKind: MetricSourceKind;
  embeddedSource?: EmbeddedMetricSource;
  collectSupplement?: (source: EmbeddedMetricSource) => Promise<string[]>;
  signal: AbortSignal;
  onWindowStart?: () => void;
  bundle: EvidenceBundle;
}

export interface MetricRunControl {
  signal?: AbortSignal;
  onWindowStart?: () => void;
}
