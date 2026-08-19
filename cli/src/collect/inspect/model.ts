import type { Toolchain } from "@compforge/doctor-plugin";
import type { Diagnosis, Evidence, Fact, ObservationMeta } from "../protocol";
import type { Executor, KubectlOptions } from "../../infra/k8s/executor";
import type { KubernetesAccessContext } from "../../infra/k8s/access";
import type { CommandContext } from "../../command";
import type { ResolvedNamespace } from "../../infra/k8s/context";
import type { KubernetesWorkloadConfigSnapshot } from "../../infra/k8s/workload-config";
import type { EvidenceBundle } from "../evidence";

export type InspectOutputFormat = "default" | "bundle" | "json" | "html" | "md";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface CollectInspectCliOpts {
  namespace?: string;
  services?: string;
  deploymentConfig?: boolean;
  dependencies?: boolean;
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

export interface InspectFacts {
  serviceTargets: Fact<{ services: Record<string, InspectServiceTargetFact> }>;
  deploymentConfiguration: Fact<{ requested: true }>;
  dependencyTargets: Fact<{ targets: InspectDependencyTarget[]; missing: string[] }>;
}

export interface EnvironmentConfigObservation extends ObservationMeta {
  kind: "environment-config";
  service: string;
  deployment: string;
  container: string;
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
  | DependencyInventoryObservation;

export interface ConfigurationComparisonRow {
  name: string;
  env?: JsonValue;
}

export interface InspectEvidence extends Evidence<InspectObservation, InspectFacts> {
  rows: ConfigurationComparisonRow[];
}

export type InspectFinding = never;
export type InspectDiagnosisGoal =
  | "environment-config"
  | "workload-runtime"
  | "runtime-dependencies";
export type InspectDiagnosis = Diagnosis<InspectEvidence, InspectFinding, InspectDiagnosisGoal>;

export interface InspectCommandContext {
  command: CommandContext;
  config: InspectConfig;
  executor: Executor;
  authorization: KubernetesAccessContext;
  bundle: EvidenceBundle;
  workloadConfig?: KubernetesWorkloadConfigSnapshot;
  log: (line: string) => void;
}
