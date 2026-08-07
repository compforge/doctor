import type {
  TenantConfigReader,
  TenantConfigTarget,
  Toolchain,
} from "@compforge/doctor-plugin";
import type { Diagnosis, Evidence, Fact, ObservationMeta } from "../protocol";
import type { DatabaseIdentity } from "../../infra/database";
import type { Executor, KubectlOptions } from "../../infra/k8s/executor";
import type { KubernetesAccessContext } from "../../infra/k8s/access";
import type { KubernetesWorkloadConfigSnapshot } from "../../infra/k8s/workload-config";
import type { EvidenceBundle } from "../evidence";

export type ConfigOutputFormat = "json" | "html" | "md";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type TenantConfigScope = string;

export interface CollectConfigCliOpts {
  namespace?: string;
  services?: string;
  deploymentConfig?: boolean;
  dependencies?: boolean;
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
  includeDeploymentConfig: boolean;
  includeDependencies: boolean;
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

export interface ConfigPodContainerFact {
  name: string;
  image: string;
  imageId?: string;
  requests: { cpu?: string; memory?: string };
  limits: { cpu?: string; memory?: string };
}

export interface ConfigPodRuntimeFact {
  pod: string;
  phase: string;
  containers: ConfigPodContainerFact[];
}

export interface ConfigServiceTargetFact {
  service: string;
  toolchain?: Toolchain;
  deployments: ConfigDeploymentTarget[];
  unavailableDeployments: Array<{ deployment: string; reason: string }>;
  podRuntime: Fact<{ pods: ConfigPodRuntimeFact[] }>;
}

export interface ConfigDependencyTarget {
  id: string;
  services: string[];
  pod: string;
  container: string;
  image: string;
  imageId?: string;
  toolchain: Toolchain;
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
  deploymentConfiguration: Fact<{ requested: true }>;
  dependencyTargets: Fact<{ targets: ConfigDependencyTarget[]; missing: string[] }>;
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

export interface RuntimeDependency {
  name: string;
  version?: string;
}

export interface DependencyInventoryObservation extends ObservationMeta {
  kind: "dependency-inventory";
  services: string[];
  pod: string;
  container: string;
  image: string;
  imageId?: string;
  toolchain: Toolchain;
  status: "collected" | "unavailable";
  runtimeVersion?: string;
  dependencies: RuntimeDependency[];
  truncated?: boolean;
  reason?: string;
}

export type ConfigObservation =
  | EnvironmentConfigObservation
  | TenantConfigObservation
  | DependencyInventoryObservation;

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
export type ConfigDiagnosisGoal =
  | "environment-config"
  | "workload-runtime"
  | "runtime-dependencies"
  | "tenant-config";
export type ConfigDiagnosis = Diagnosis<ConfigEvidence, ConfigFinding, ConfigDiagnosisGoal>;

export interface ConfigCollectContext {
  executor: Executor;
  authorization: KubernetesAccessContext;
  pluginConfig: Readonly<Record<string, unknown>>;
  bundle: EvidenceBundle;
  workloadConfig?: KubernetesWorkloadConfigSnapshot;
  tenantConfigReader?: TenantConfigReader;
  closeTenantAccess?: () => Promise<void>;
  log: (line: string) => void;
}
