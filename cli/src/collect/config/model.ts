import type { TenantConfigReader, TenantConfigTarget } from "@compforge/doctor-plugin";
import type { Diagnosis, Evidence, Fact, ObservationMeta } from "../protocol";
import type { DatabaseIdentity } from "../../infra/database";
import type { Executor, KubectlOptions } from "../../infra/k8s/executor";
import type { KubernetesWorkloadConfigSnapshot } from "../../infra/k8s/workload-config";
import type { EvidenceBundle } from "../evidence";

export type ConfigOutputFormat = "json" | "html" | "md";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type TenantConfigScope = string;

export interface CollectConfigCliOpts {
  namespace?: string;
  services?: string;
  tenantId?: string;
  tenantName?: string;
  tenantConfigService?: string;
  tenantDirectoryService?: string;
  tenantDirectoryPort?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
}

export interface ConfigCollectConfig {
  namespace: string;
  namespaceSource: string;
  services: string[];
  servicesExplicit: boolean;
  tenantId?: string;
  tenantName?: string;
  fallbackIdentity?: DatabaseIdentity;
  tenantConfiguration?: {
    scopes: string[];
    directoryTarget: TenantConfigTarget;
    databaseService: string;
  };
  format: ConfigOutputFormat;
  outputPath?: string;
  reportName: string;
  profileName: string;
  kube: KubectlOptions & { namespace: string };
}

export interface ConfigDeploymentTarget {
  service: string;
  deployment: string;
  container: string;
}

export interface ConfigServiceTargetFact {
  service: string;
  deployments: ConfigDeploymentTarget[];
  unavailableDeployments: Array<{ deployment: string; reason: string }>;
}

export interface ConfigTenantDatabaseTargetFact {
  service: string;
  endpoint: string;
  database: string;
  username: string;
  credentialSource: string;
}

export interface ConfigInspectionFacts {
  serviceTargets: Fact<{ services: Record<string, ConfigServiceTargetFact> }>;
  tenantDatabaseTarget: Fact<ConfigTenantDatabaseTargetFact>;
  tenantRequest: Fact<{ tenantId: string; tenantName?: string; scopes: string[] }>;
}

export interface EnvironmentConfigObservation extends ObservationMeta {
  kind: "environment-config";
  service: string;
  deployment: string;
  container: string;
  values: Record<string, JsonValue>;
}

export interface TenantConfigObservation extends ObservationMeta {
  kind: "tenant-config";
  tenantId: string;
  tenantName?: string;
  scope: TenantConfigScope;
  values: Record<string, JsonValue>;
}

export type ConfigObservation = EnvironmentConfigObservation | TenantConfigObservation;

export interface ConfigComparisonRow {
  name: string;
  env?: JsonValue;
  tenantConfig?: {
    value: JsonValue;
    scope: TenantConfigScope;
  };
}

export interface ConfigEvidence extends Evidence<ConfigObservation, ConfigInspectionFacts> {
  rows: ConfigComparisonRow[];
}

export type ConfigFinding = never;
export type ConfigDiagnosisGoal = "environment-config" | "tenant-config";
export type ConfigDiagnosis = Diagnosis<ConfigEvidence, ConfigFinding, ConfigDiagnosisGoal>;

export interface ConfigCollectContext {
  executor: Executor;
  bundle: EvidenceBundle;
  workloadConfig?: KubernetesWorkloadConfigSnapshot;
  tenantConfigReader?: TenantConfigReader;
  closeTenantAccess?: () => Promise<void>;
  log: (line: string) => void;
}
