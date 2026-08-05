import type { Diagnosis, Evidence, Fact, FindingMeta, ObservationMeta } from "../protocol";
import type {
  PluginContext,
  ServiceDataFinding,
  ServiceDataResult,
  ServiceDataSummary,
} from "@compforge/doctor-plugin";
import type { DatabaseIdentity } from "../../infra/database";
import type { KubectlOptions } from "../../infra/k8s/executor";
import type { EvidenceBundle } from "../evidence";

export type DataOutputFormat = "json" | "html";
export type SupportedDataService = string;

export interface CollectDataCliOpts {
  bizId: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
  services?: string;
}

export interface DataConfig {
  ids: string[];
  format: DataOutputFormat;
  outputPath?: string;
  reportName: string;
  profileName: string;
  fallbackIdentity?: DatabaseIdentity;
  namespace: string;
  namespaceSource: string;
  services: string[];
  servicesExplicit: boolean;
  kube: KubectlOptions & { namespace: string };
}

export interface DataServiceSelection {
  service: string;
}

export interface DataTargetFact {
  service: string;
  endpoint: string;
  database: string;
  username: string;
  credentialSource: string;
}

export interface DataServiceFacts {
  target: Fact<DataTargetFact>;
  capability: Fact<{ queryable: true }>;
}

export interface DataInspectionFacts {
  services: Record<string, DataServiceFacts>;
}

export interface DataObservation extends ObservationMeta {
  kind: "service-data-inspection";
  stage: "expand" | "provide";
  service: string;
  result: ServiceDataResult;
  summary: ServiceDataSummary;
}
export type DataEvidence = Evidence<DataObservation, DataInspectionFacts>;

export type DataFinding = FindingMeta<string> & ServiceDataFinding & { service: string };

export type DataDiagnosisGoal = "business-data-relations";
export type DataDiagnosis = Diagnosis<DataEvidence, DataFinding, DataDiagnosisGoal>;

export interface DataCollectContext {
  pluginContexts: Readonly<Record<string, PluginContext>>;
  bundle: EvidenceBundle;
  log: (line: string) => void;
}
