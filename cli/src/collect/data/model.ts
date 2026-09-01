import type { Diagnosis, Evidence, Fact, FindingMeta } from "../protocol";
import type {
  Identity,
  ServiceInspectResult,
} from "@compforge/doctor-plugin";
import type { ServiceDetectorFinding } from "../../plugin/evidence-detector";
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
  target: Fact<DataTargetFact, "data.service-target">;
  inspect: Fact<{ queryable: true }, "data.inspect-capability">;
}

export interface DataInspectionFacts {
  services: Record<string, DataServiceFacts>;
}

export interface DataInspectResultIdentity {
  id: string;
  stage: "expand" | "provide";
  service: string;
  identity: Identity;
}

export type DataInspectResult = DataInspectResultIdentity & Fact<{
  result: ServiceInspectResult;
}, "data.inspect-result">;

export type CollectedDataInspectResult = Extract<DataInspectResult, { status: "collected" }>;

export interface DataFacts extends DataInspectionFacts {
  capabilityResults: readonly DataInspectResult[];
}

export type DataEvidence = Evidence<never, DataFacts>;

export type DataFinding = FindingMeta<string> & ServiceDetectorFinding;

export type DataDiagnosisGoal = "business-data-relations";
export type DataDiagnosis = Diagnosis<DataEvidence, DataFinding, DataDiagnosisGoal>;
