import type { KubernetesResourceReader } from "../../infra/k8s/resources";
import type { TimeWindowOptions } from "../time-window";
import type { InspectTimeWindow } from "@compforge/doctor-plugin";
import type { JsonObject, JsonValue as PortableJsonValue } from "@compforge/harness-common";
import type { Toolchain, Workload, WorkloadInstance } from "@compforge/doctor-plugin";
import type { Diagnosis, Evidence, Fact, FindingMeta, ObservationMeta } from "../protocol";
import type { ServiceDetectorFinding } from "../../plugin/evidence-detector";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { KubernetesAccessContext } from "../../infra/k8s/access";
import type { CommandContext } from "../../command";
import type { ResolvedNamespace } from "../../infra/k8s/context";
import type { KubernetesWorkloadConfigSnapshot } from "../../infra/k8s/workload-config";
import type { KubernetesAutoscaler, KubernetesWorkloadEvent } from "../../infra/k8s/workload-events";
import type { EvidenceBundle } from "../evidence";

export type InspectOutputFormat = "default" | "bundle" | "json" | "html" | "md" | "summary";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type InspectField = "env" | "image" | "config" | "event" | "hpa";

export interface CollectInspectCliOpts extends TimeWindowOptions {
  namespace?: string;
  services?: readonly string[];
  deploymentConfig?: boolean;
  search?: string;
  field?: InspectField;
  dependencies?: boolean;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
}

export interface InspectConfig {
  timeWindow?: InspectTimeWindow;
  namespace: string;
  namespaceSource: ResolvedNamespace["source"];
  services: string[];
  servicesExplicit: boolean;
  includeDeploymentConfig?: boolean;
  search?: string;
  field?: InspectField;
  includeDependencies?: boolean;
  format: InspectOutputFormat;
  outputPath?: string;
  reportName: string;
  profileName: string;
  kube: KubectlOptions & { namespace: string };
}

export interface InspectDeploymentTarget {
  service: string;
  workload: string;
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
  instance: WorkloadInstance;
  pod: string;
  serviceAccountName: string;
  nodeName?: string;
  /** Business container resolved from the Workload declaration or Service ports. */
  environmentContainer?: string;
  environmentUnavailableReason?: string;
  phase: string;
  reason?: string;
  message?: string;
  conditions: InspectPodConditionFact[];
  containers: InspectPodContainerFact[];
}

export interface InspectWorkloadTargetFact {
  name: string;
  description?: string;
  location: Workload["location"];
  probes: string[];
  deployments: InspectDeploymentTarget[];
  unavailableDeployments: Array<{ deployment: string; reason: string }>;
  podRuntime: Fact<{ pods: InspectPodRuntimeFact[] }, "inspect.workload-pods">;
}

export interface InspectServiceTargetFact {
  service: string;
  toolchain?: Toolchain;
  files?: Array<{ id: string; path: string; workload: string }>;
  workloads: Record<string, InspectWorkloadTargetFact>;
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
  serviceTargets: Fact<{ services: Record<string, InspectServiceTargetFact> }, "inspect.service-targets">;
  deploymentConfiguration: Fact<{ requested: true }, "inspect.deployment-configuration">;
  dependencyTargets: Fact<{
    targets: InspectDependencyTarget[];
    missing: string[];
  }, "inspect.dependency-targets">;
  /** 与所选 Workload 相关的 Event/HPA；完整 Inspect 为补充证据，显式 field 纳入采集结果。 */
  lifecycleSignals: Fact<{
    events: KubernetesWorkloadEvent[];
    eventsObservedAt?: string;
    timeWindow?: InspectTimeWindow;
    omittedEvents?: number;
    autoscalers: KubernetesAutoscaler[];
  }, "inspect.lifecycle-signals">;
}

export interface EnvironmentConfigObservation extends ObservationMeta {
  kind: "environment-config";
  service: string;
  deployment: string;
  container: string;
  values: Record<string, JsonValue>;
}

export interface ContainerEnvironmentTarget {
  service: string;
  workload: string;
  pod: string;
  container: string;
}

export interface ContainerEnvironmentObservation extends ObservationMeta, ContainerEnvironmentTarget {
  kind: "container-environment";
  status: "collected" | "unavailable";
  values: Record<string, string>;
  reason?: string;
}

/** Wall time is a local reference, not an assertion of UTC correctness. */
export interface PodClockReference {
  id: string;
  host: string;
  wallTimeMs: number;
  monotonicMs: number;
}

export interface PodClockSample {
  hostStartMs: number;
  hostEndMs: number;
  monotonicStartMs: number;
  monotonicEndMs: number;
  stdout: string;
  podTimeMs?: number;
  resolutionMs?: number;
  reason?: string;
}

export interface PodClockObservation extends ObservationMeta {
  kind: "pod-clock";
  service: string;
  workload: string;
  instance: WorkloadInstance;
  pod: string;
  container?: string;
  nodeName?: string;
  reference: PodClockReference;
  status: "collected" | "unavailable";
  reason?: string;
  samples: PodClockSample[];
}

export interface PodClockFinding extends FindingMeta<"clock.host-offset" | "clock.pod-spread"> {
  subject: string;
  message: string;
  thresholdMs: number;
  minimumOffsetMs: number;
}

export interface FileConfigurationObservation extends ObservationMeta {
  kind: "file-configuration";
  service: string;
  workload: string;
  path: string;
  namespace?: string;
  pod?: string;
  container?: string;
  status: "collected" | "unavailable";
  values: Record<string, JsonValue>;
  reason?: string;
}

export interface SecretConfigurationObservation extends ObservationMeta {
  kind: "secret-configuration";
  service: string;
  dataSource: string;
  keys: readonly string[];
  namespace?: string;
  name?: string;
  resourceVersion?: string;
  observedAt?: string;
  status: "collected" | "unavailable";
  values: Record<string, string>;
  missingKeys: string[];
  reason?: string;
}

export interface ConfigSearchMatch {
  name: string;
  value: JsonValue;
  source: "env" | "file" | "secret";
  service: string;
  workload?: string;
  secret?: string;
  dataSource?: string;
  resourceVersion?: string;
  namespace?: string;
  pod?: string;
  container?: string;
  path?: string;
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

export interface KubernetesAppArmorAdmissionObservation extends ObservationMeta {
  kind: "kubernetes-apparmor-unconfined-admission";
  service: string;
  probe: string;
  namespace: string;
  serviceAccountName: string;
  status: "allowed" | "denied";
  reason?: string;
}

export interface PluginWorkloadObservation extends ObservationMeta {
  status: "ok" | "partial" | "unavailable";
  reason?: string;
  summary: import("@compforge/harness-common").Summary;
  kind: "plugin-workload";
  instance: WorkloadInstance;
  observationKind: string;
  observationSchemaVersion: number;
  service: string;
  workload: string;
  namespace: string;
  pod: string;
  container?: string;
  probe: string;
  value: PortableJsonValue;
}

export type InspectObservation =
  | EnvironmentConfigObservation
  | PodClockObservation
  | ContainerEnvironmentObservation
  | FileConfigurationObservation
  | SecretConfigurationObservation
  | DependencyInventoryObservation
  | KubernetesAppArmorAdmissionObservation
  | PluginWorkloadObservation;

export interface ConfigurationComparisonRow {
  name: string;
  env?: JsonValue;
}

export interface InspectEvidence extends Evidence<InspectObservation, InspectFacts> {
  rows: ConfigurationComparisonRow[];
  search?: InspectSearchResult;
}

export interface EnvSearchMatch extends ContainerEnvironmentTarget {
  name: string;
  value: string;
}

export interface ImageSearchMatch {
  image: string;
  imageId?: string;
  service: string;
  workload: string;
  pod: string;
  container: string;
}

export type InspectSearchResult = { keyword?: string } & (
  | { field: "env"; matches: EnvSearchMatch[] }
  | { field: "image"; matches: ImageSearchMatch[] }
  | { field: "config"; matches: ConfigSearchMatch[] }
  | { field: "event"; matches: KubernetesWorkloadEvent[] }
  | { field: "hpa"; matches: KubernetesAutoscaler[] }
);

export type InspectFinding = ServiceDetectorFinding | PodClockFinding | import("../evidence-gaps").EvidenceGapFinding;
export type InspectDiagnosisGoal =
  | "environment-config"
  | "container-environment"
  | "file-configuration"
  | "secret-configuration"
  | "workload-runtime"
  | "runtime-dependencies"
  | "workload-observations"
  | "event"
  | "hpa";
export type InspectDiagnosis = Diagnosis<InspectEvidence, InspectFinding>;

export interface InspectCommandContext {
  command: CommandContext;
  config: InspectConfig;
  executor: Executor;
  resources: KubernetesResourceReader;
  exec: Executor["exec"];
  authorization: KubernetesAccessContext;
  bundle: EvidenceBundle;
  workloadConfig?: KubernetesWorkloadConfigSnapshot;
  log: (line: string) => void;
}

export function fileConfigurationId(service: string, clientKey: string, path: string): string {
  return `file-config-${service}-${clientKey}-${encodeURIComponent(path)}`;
}

/** @spec A field selects collection, authorization and execution; format only selects delivery. */
export function inspectCollectionScope(config: Pick<InspectConfig, "field" | "includeDeploymentConfig" | "includeDependencies">) {
  return {
    clock: config.field === undefined,
    env: config.field === "env" || config.field === "config",
    files: config.field === "config",
    secrets: config.field === undefined || config.field === "config",
    event: config.field === undefined || config.field === "event",
    hpa: config.field === undefined || config.field === "hpa",
    plugins: config.field === undefined,
    deployment: config.field === undefined && config.includeDeploymentConfig === true,
    dependencies: config.field === undefined && config.includeDependencies === true,
  };
}
