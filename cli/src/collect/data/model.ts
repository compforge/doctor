import type { TimeWindowOptions } from "../time-window";
import type { InspectTimeWindow } from "@compforge/doctor-plugin";
import type { Diagnosis, Evidence, Fact, FindingMeta } from "../protocol";
import type {
  Identity,
  ServiceInspectResult,
} from "@compforge/doctor-plugin";
import type { ServiceDetectorFinding } from "../../plugin/evidence-detector";
import type { DatabaseIdentity } from "../../infra/database";
import type { KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";

export type DataOutputFormat = "default" | "bundle" | "json" | "html" | "summary";
export type SupportedDataService = string;

export interface CollectDataCliOpts extends TimeWindowOptions {
  /** Internal query constraint; the Data CLI does not expose tenant selectors. */
  tenantId?: string;
  tenantName?: string;
  bizIds?: readonly string[];
  bizTypes?: readonly string[];
  page?: string | number;
  pageSize?: string | number;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
  services?: readonly string[];
}

export interface DataConfig {
  tenantId?: string;
  tenantName?: string;
  timeWindow?: InspectTimeWindow;
  ids: string[];
  list?: { bizTypes: string[]; page: number; pageSize: number };
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

export interface DataServiceFacts {
  inspect: Fact<{ queryable: true }, "data.inspect-capability">;
}

export interface DataInspectionFacts {
  services: Record<string, DataServiceFacts>;
}

export interface DataInspectResultIdentity {
  sources?: readonly import("@compforge/doctor-plugin").ServiceInspectSource[];
  id: string;
  stage: "expand" | "provide";
  /** Specific Extension producer; older stored results use inspect. */
  extension?: string;
  service: string;
  identity: Identity;
}

export type DataInspectResult = DataInspectResultIdentity & Fact<{
  result: ServiceInspectResult;
}, "data.inspect-result">;

export type CollectedDataInspectResult = Extract<DataInspectResult, { status: "collected" }>;

export interface DataFacts extends DataInspectionFacts {
  capabilityResults: readonly DataInspectResult[];
  typeResults?: readonly DataTypeFact[];
}

export type DataEvidence = Evidence<never, DataFacts>;

export type DataFinding = FindingMeta<string> & ServiceDetectorFinding;

export type DataDiagnosis = Diagnosis<DataEvidence, DataFinding>;

export type DataTypeResult = {
  service: string;
  extension: string;
  bizType: string;
} & (
  | { status: import("../../command").CommandStatus.Ok | import("../../command").CommandStatus.Partial; data: import("@compforge/doctor-plugin").DataPage<import("@compforge/harness-common").SerializedValue> }
  | { status: import("../../command").CommandStatus.Failed | import("../../command").CommandStatus.Cancelled; reason: string }
);

export type DataTypeFact = Fact<{ data: import("@compforge/doctor-plugin").DataPage<import("@compforge/harness-common").SerializedValue> }, "data.type-result">
  & Pick<DataTypeResult, "service" | "extension" | "bizType"> & { cancelled?: boolean };

export interface DataOutput {
  readonly tenant?: { id: string; name?: string };
  readonly typeResults?: readonly DataTypeResult[];
  readonly items: readonly {
    bizId: string;
    status: import("../../command").CommandStatus;
    artifacts: readonly import("../../command").CommandArtifact[];
    diagnosis?: DataDiagnosis;
    reason?: string;
  }[];
}
