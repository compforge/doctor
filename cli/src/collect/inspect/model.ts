import type {
  TenantConfigReader,
  TenantConfigTarget,
  Toolchain,
} from "@compforge/doctor-plugin";
import type { Diagnosis, Evidence, Fact, ObservationMeta } from "../protocol";
import type { DatabaseIdentity } from "../../infra/database";
import type { Executor, KubectlOptions } from "../../infra/k8s/executor";
import type { KubernetesAccessContext } from "../../infra/k8s/access";
import type { ResolvedNamespace } from "../../infra/k8s/context";
import type { KubernetesWorkloadConfigSnapshot } from "../../infra/k8s/workload-config";
import type { EvidenceBundle } from "../evidence";

export type InspectOutputFormat = "json" | "html" | "md";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type TenantConfigScope = string;

export interface CollectInspectCliOpts {
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

export interface InspectConfig {
  namespace: string;
  namespaceSource: ResolvedNamespace["source"];
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
  format: InspectOutputFormat;
  outputPath?: string;
  reportName: string;
  profileName: string;
  kube: KubectlOptions & { namespace: string };
}

export interface InspectDeploymentTarget {
  service: string;
  deployment: string;
  container: string;
}

export interface InspectPodContainerFact {
  name: string;
  image: string;
  imageId?: string;
  requests: { cpu?: string; memory?: string };
  limits: { cpu?: string; memory?: string };
  ready?: boolean;
  restartCount: number;
  state?:
    | { kind: "waiting"; reason?: string; message?: string }
    | { kind: "running"; startedAt?: string }
    | ({ kind: "terminated" } & InspectContainerTerminationFact);
  lastTermination?: InspectContainerTerminationFact;
}

export interface InspectContainerTerminationFact {
  exitCode?: number;
  signal?: number;
  reason?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface InspectPodConditionFact {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface InspectPodRuntimeFact {
  pod: string;
  phase: string;
  reason?: string;
  message?: string;
  conditions: InspectPodConditionFact[];
  containers: InspectPodContainerFact[];
}

export interface InspectServiceTargetFact {
  service: string;
  toolchain?: Toolchain;
  configurationSupported: boolean;
  deployments: InspectDeploymentTarget[];
  unavailableDeployments: Array<{ deployment: string; reason: string }>;
  podRuntime: Fact<{ pods: InspectPodRuntimeFact[] }>;
}

export interface InspectDependencyTarget {
  id: string;
  services: string[];
  pod: string;
  container: string;
  image: string;
  imageId?: string;
  toolchain: Toolchain;
}

export interface InspectTenantDatabaseTargetFact {
  service: string;
  endpoint: string;
  database: string;
  username: string;
  credentialSource: string;
}

export interface InspectFacts {
  serviceTargets: Fact<{ services: Record<string, InspectServiceTargetFact> }>;
  deploymentConfiguration: Fact<{ requested: true }>;
  dependencyTargets: Fact<{ targets: InspectDependencyTarget[]; missing: string[] }>;
  tenantDatabaseTarget: Fact<InspectTenantDatabaseTargetFact>;
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

export type InspectObservation =
  | EnvironmentConfigObservation
  | TenantConfigObservation
  | DependencyInventoryObservation;

export interface ConfigurationComparisonRow {
  name: string;
  env?: JsonValue;
  tenantConfig?: {
    value: JsonValue;
    scope: TenantConfigScope;
  };
}

export interface InspectEvidence extends Evidence<InspectObservation, InspectFacts> {
  rows: ConfigurationComparisonRow[];
}

export type InspectFinding = never;
export type InspectDiagnosisGoal =
  | "environment-config"
  | "workload-runtime"
  | "runtime-dependencies"
  | "tenant-config";
export type InspectDiagnosis = Diagnosis<InspectEvidence, InspectFinding, InspectDiagnosisGoal>;

export interface InspectCollectContext {
  executor: Executor;
  authorization: KubernetesAccessContext;
  pluginConfig: Readonly<Record<string, unknown>>;
  bundle: EvidenceBundle;
  workloadConfig?: KubernetesWorkloadConfigSnapshot;
  tenantConfigReader?: TenantConfigReader;
  closeTenantAccess?: () => Promise<void>;
  log: (line: string) => void;
}
