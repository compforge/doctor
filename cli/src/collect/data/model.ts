import type { Diagnosis, Evidence, Fact, FindingMeta } from "../protocol";
import type {
  Identity,
  ServiceDataFact,
  ServiceDataFinding,
  ServiceDataSummary,
} from "@compforge/doctor-plugin";
import type { DatabaseIdentity } from "../../infra/database";
import type { KubectlOptions } from "../../infra/k8s/executor";

export type DataOutputFormat = "default" | "bundle" | "json" | "html";
export type SupportedDataService = string;

export interface CollectDataCliOpts {
  bizIds?: string[];
  /** @deprecated Use bizIds. */
  bizId?: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
  services?: string;
  /** Internal batch label used to keep per-ID failure bundles distinct. */
  reportName?: string;
}

export interface DataConfig {
  ids: string[];
  format: DataOutputFormat;
  outputPath: string;
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

export interface DataCapabilityFactIdentity {
  id: string;
  stage: "expand" | "provide";
  service: string;
  identity: Identity;
}

export type DataCapabilityFact = DataCapabilityFactIdentity & Fact<{
  fact: ServiceDataFact;
  summary: ServiceDataSummary;
}>;

export type CollectedDataCapabilityFact = DataCapabilityFactIdentity
  & { status: "collected" }
  & {
    fact: ServiceDataFact;
    summary: ServiceDataSummary;
  };

export interface DataFacts extends DataInspectionFacts {
  capabilityFacts: readonly DataCapabilityFact[];
}

export type DataEvidence = Evidence<never, DataFacts>;

export type DataFinding = FindingMeta<string> & ServiceDataFinding & { service: string };

export type DataDiagnosisGoal = "business-data-relations";
export type DataDiagnosis = Diagnosis<DataEvidence, DataFinding, DataDiagnosisGoal>;
