import type { Case, CaseSet } from "@compforge/spec-case/model";
import type { PluginContext } from "./context";
import type {
  Fact,
  Identity,
  InspectCapability,
  InspectQueryResult,
  Query,
} from "./capability";
import type {
  ModelCatalog,
  ModelInference,
  ModelInferenceTarget,
} from "./definition";
import type { ServiceMcpCapability } from "./mcp";
import type { CapabilityWithAccess } from "./kubernetes";
import type { ProbeCapability, ProbeRunner } from "./probe";
import type { ServiceWorkloadDefinition, WorkloadInstance } from "./workload";

export interface ServiceEndpoint {
  /** Explicit network host; a logical Service name is never treated as transport identity. */
  host: string;
  port: number;
}

export interface TenantSummary {
  id: string;
  name: string;
  displayName: string;
}

export interface UserSummary {
  id: string;
  name: string;
  displayName: string;
}

export interface UserDirectorySearch {
  tenantId: string;
  query?: string;
  page: number;
  pageSize: number;
}

export interface UserDirectorySearchResult {
  users: UserSummary[];
  total: number;
}

export interface TenantDirectory {
  listActive(): Promise<TenantSummary[]>;
  getByName(name: string): Promise<TenantSummary>;
  /** Optional because tenant-only directory providers do not need to expose users. */
  searchActiveUsers?(input: UserDirectorySearch): Promise<UserDirectorySearchResult>;
}

export interface ServiceTenantDirectoryCapability extends CapabilityWithAccess {
  endpoint: ServiceEndpoint;
  create(context: PluginContext): TenantDirectory;
}

export interface ServiceModelCatalogCapability extends CapabilityWithAccess {
  endpoint: ServiceEndpoint;
  create(context: PluginContext): ModelCatalog;
}

export interface ServiceInferenceCapability extends CapabilityWithAccess {
  endpoint: ServiceEndpoint;
  /** Resolve only after required connectivity, including any port-forward, is ready for use. */
  create(
    context: PluginContext,
    target: ModelInferenceTarget,
    timeoutMs: number,
  ): Promise<ModelInference>;
}

export interface ServiceMetricQuery {
  /** Query for a cumulative /metrics snapshot. */
  instant: string;
  /** Query for a watched window. `{{window}}` is replaced with the collection duration. */
  range: string;
}

export interface ServiceMetricChart {
  id: string;
  title: string;
  description: string;
  kind: "line" | "pie";
  query: ServiceMetricQuery;
  unit?: "seconds" | "percent" | "count";
  /** PromQL result labels used as the chart series/slice name. */
  label?: string;
}

export interface ServiceMetricDetector {
  id: string;
  title: string;
  query: ServiceMetricQuery;
  operator: "gt";
  threshold: number;
  severity: "warning" | "critical";
  message: string;
}

/** Common identity carried by every Plugin-side Probe contribution. */
export interface ServiceProbe {
  id: string;
  kind: string;
  schemaVersion: number;
}

export interface KubernetesAppArmorUnconfinedInspectionProbe extends ServiceProbe {
  kind: "kubernetes.apparmor-unconfined-admission";
  schemaVersion: 1;
  /** Resolve the caller identity and probe image from this Service's running workload. */
  subject: "workload-service-account";
}

/** Service-owned declarations adapted to common probes by Doctor. */
export type ServiceEnvironmentProbe = KubernetesAppArmorUnconfinedInspectionProbe;

/** Service-owned Prometheus contract consumed by doctor metric. */
export interface ServiceMetricCapability {
  endpoint: ServiceEndpoint & { path: string };
  /** Limits embedded scraping to the metric families required by this declaration. */
  metricNames: readonly string[];
  charts: readonly ServiceMetricChart[];
  detectors?: readonly ServiceMetricDetector[];
}

/** Protocol facts returned by one Case trigger; Doctor maps them to the shared Perf Outcome IR. */
export interface ServiceCaseObservation {
  status: number | null;
  durationMs: number;
  events?: number;
  nbytes?: number;
  metrics?: Readonly<Record<string, number>>;
  meta?: Readonly<Record<string, unknown>>;
  errorKind?: string;
}

export interface ServiceCaseVerdict {
  ok: boolean;
  errorKind?: string;
}

export interface ServiceRequestIdentity {
  tenantId: string;
  userId: string;
}

/**
 * Declares that a Case needs tenant/user identity from a tenant directory.
 * The Plugin owns its profile schema; Core only fills missing identity interactively.
 */
export interface ServiceCaseIdentityRequirement {
  directoryService: string;
  configured(config: Readonly<Record<string, unknown>>): Partial<ServiceRequestIdentity>;
}

/**
 * Service protocol adapter invoked concurrently by Core at Harness-owned dispatch points.
 * A runner must not create an independent load loop: request budgets, timing and cancellation
 * belong to Core so every Outcome remains attributable to one Trial and Window.
 */
export interface ServiceCaseRunner extends ProbeRunner<Case, ServiceCaseObservation> {
  /** Pure per-request protocol classification; aggregate Case/Perf judgment stays outside the runner. */
  classify(observation: ServiceCaseObservation): ServiceCaseVerdict;
}

export interface ServiceCaseProbeOptions {
  caseSetId: string;
  timeoutMs: number;
  requestIdentity?: ServiceRequestIdentity;
}

/** Service-owned single-Case Probe Capability consumed by Eval and Perf Harness callers. */
export interface ServiceCaseCapability
  extends ProbeCapability<Case, ServiceCaseObservation, ServiceCaseProbeOptions> {
  endpoint: ServiceEndpoint;
  /** Canonical assets owned and validated by spec-case; commands only select and execute them. */
  caseSets: readonly CaseSet[];
  requestIdentity?: ServiceCaseIdentityRequirement;
  createRunner(
    context: PluginContext,
    input: ServiceCaseProbeOptions,
  ): Promise<ServiceCaseRunner>;
}

export interface ServicePerfObservability {
  metricServices: readonly string[];
  logServices: readonly string[];
  /** Ordered Outcome.meta keys accepted by the Service traceId resolver. */
  correlationKeys: readonly string[];
}

export interface ServicePerfCaseSelection {
  caseId: string;
  weight?: number;
}

export interface ServicePerfScenario {
  id: string;
  title: string;
  description: string;
  caseSetId: string;
  cases: readonly ServicePerfCaseSelection[];
  observability: ServicePerfObservability;
}

/** Service-owned Perf presets; Core owns scheduling and the Case capability owns request protocol. */
export interface ServicePerfCapability {
  scenarios: readonly ServicePerfScenario[];
}

export interface ServiceInspectResolution {
  inputId: string;
  resolvedAs: string;
  /** Presentation-only identifiers. Query expansion consumes RelationFacts. */
  identifiers: Readonly<Record<string, string | undefined>>;
}

export interface ServiceInspectTruncation {
  reason: string;
  omittedFacts?: number;
}

/** Query-level outcome; acquisition state is not disguised as a domain Fact. */
export interface ServiceInspectResult<F extends Fact = Fact> extends InspectQueryResult<F> {
  resolution: ServiceInspectResolution;
  /** Optional sources that could not contribute to this otherwise collected result. */
  missingEvidence?: readonly string[];
  /** Explicitly records provider-side or Core-side capacity truncation. */
  truncated?: ServiceInspectTruncation;
}

export interface ServiceInspectBudget {
  maxFacts: number;
  maxBytes: number;
}

export type ServiceEvidenceRole = "supporting" | "contradicting" | "context";

export type ServiceEvidenceReference =
  | { observationId: string; role: ServiceEvidenceRole }
  | { factPath: string; role: ServiceEvidenceRole };

export type ServiceEvidenceProducer =
  | { origin: "core"; id: string }
  | { origin: "plugin"; plugin: string; service: string; id: string };

export interface ServiceFinding {
  id: string;
  kind: string;
  schemaVersion: number;
  severity: "info" | "warning" | "critical";
  confidence: "low" | "medium" | "high";
  message: string;
  /** Every business judgment names the persisted evidence that supports or qualifies it. */
  evidence: readonly ServiceEvidenceReference[];
  [name: string]: unknown;
}

/** One Core- or Plugin-produced Inspect Fact exposed to Service Probes and Detectors. */
export interface ServiceEvidenceFact {
  /** Path below the command Evidence `facts` root; valid as a Finding fact reference. */
  factPath: string;
  /** Logical Services this Fact describes; Core Facts may cover more than one Service. */
  services: readonly string[];
  kind: string;
  schemaVersion: number;
  producer: ServiceEvidenceProducer;
  /** Present when the Fact came from a Service Inspect query. */
  query?: Identity;
  value: unknown;
}

/** One Service-scoped Probe Observation exposed to pure business detectors. */
export interface ServiceEvidenceObservation {
  /** Persisted Observation identity; valid as a Finding observation reference. */
  id: string;
  /** Logical Services this Observation describes. */
  services: readonly string[];
  probe: string;
  kind: string;
  schemaVersion: number;
  producer: ServiceEvidenceProducer;
  workload?: string;
  instance?: WorkloadInstance;
  value: Readonly<Record<string, unknown>>;
}

/** Serializable, read-only projection of the Evidence selected for Service detectors. */
export interface ServiceEvidence {
  facts: readonly ServiceEvidenceFact[];
  observations: readonly ServiceEvidenceObservation[];
}

/** Pure business judgment over already collected Evidence; it never receives PluginContext. */
export interface ServiceDetector {
  id: string;
  detect(evidence: ServiceEvidence): readonly ServiceFinding[];
}

export interface ServiceWorkloadProbeObservation {
  value: Readonly<Record<string, unknown>>;
}

/** Core-built input shared by Service Probe capabilities after Inspect has settled. */
export interface ServiceProbeInput {
  /** Complete immutable Fact projection for this command; currently not filtered by Service or kind. */
  facts: readonly ServiceEvidenceFact[];
}

export interface ServiceWorkloadProbeInput extends ServiceProbeInput {
  instance: WorkloadInstance;
}

export interface ServiceWorkloadProbe extends ServiceProbe {
  kind: "workload";
  schemaVersion: 1;
  /** Stable WorkloadDefinition.name owned by this Service. */
  workload: string;
  /** Access is declared per Probe so unrelated probes do not inherit a broader capability grant. */
  access: CapabilityWithAccess["access"];
  /** Observation schema declared before Core schedules this Probe. */
  observation: {
    kind: string;
    schemaVersion: number;
  };
  probe(
    context: PluginContext,
    input: ServiceWorkloadProbeInput,
  ): Promise<ServiceWorkloadProbeObservation>;
}

/** Supported Probe forms at the untyped Plugin boundary. */
export type ServiceProbeDefinition = ServiceEnvironmentProbe | ServiceWorkloadProbe;

export interface ServiceInspectQuery extends Query<Identity> {
  budget: ServiceInspectBudget;
  results: ReadonlyMap<string, readonly ServiceInspectResult[]>;
}

/** Plugin 返回给 Doctor 展示和判定数据访问是否可用的脱敏结果。 */
export interface ServiceInspectTarget {
  endpoint: string;
  database: string;
  username: string;
  credentialSource: string;
}

export type ServiceInspectQueryHandler = (
  context: PluginContext,
  query: ServiceInspectQuery,
) => Promise<ServiceInspectResult>;

export interface ServiceInspect
  extends InspectCapability<ServiceInspectQuery, Fact> {
  /** Identity kinds accepted by this capability. Commands use this for capability selection. */
  accepts: readonly string[];
  /** 此 Service 可共享的稳定业务数据类型，用于 Catalog 展示与能力发现。 */
  provides: readonly string[];
  /** 存在时表示此 Service 还可提供目标为这些 Identity kind 的 Relation。 */
  expands?: readonly string[];
  /** 直接访问 Store 时声明 Store ID；通过 Service API 查询时可省略。 */
  store?: string;
  resolveTarget(context: PluginContext): Promise<ServiceInspectTarget>;
  inspect: ServiceInspectQueryHandler;
}

/** The three Plugin-side contributions that participate in Collect execute. */
export interface ServiceContributions {
  inspect?: ServiceInspect;
  probes?: readonly ServiceProbeDefinition[];
  detectors?: readonly ServiceDetector[];
}

export type ServiceContributionName = keyof ServiceContributions;

export interface ServiceTraceIdInput {
  bizId: string;
}

export interface ServiceTraceIdResolution {
  traceId: string;
  resolvedAs: string;
  /** Optional business record that directly carried this trace_id (for example a message ID). */
  sourceId?: string;
}

export type ServiceTraceIdResolutionResult =
  | ServiceTraceIdResolution
  | readonly ServiceTraceIdResolution[];

/** 把一个 Plugin 业务 ID 解析为 Doctor trace/log 消费的一条或多条规范 trace_id。 */
export interface ServiceTraceIdCapability extends CapabilityWithAccess {
  endpoint: ServiceEndpoint;
  resolve(
    context: PluginContext,
    input: ServiceTraceIdInput,
  ): Promise<ServiceTraceIdResolutionResult | undefined>;
}

export type ServiceStoreKind = "db" | "vdb" | "s3" | "redis";

interface ServiceStoreCapabilityBase {
  id: string;
  kind: ServiceStoreKind;
}

export interface ServiceDatabaseStoreCapability extends ServiceStoreCapabilityBase {
  kind: "db";
  backend: "mysql";
  envPrefix: string;
}

export interface ServiceVdbTarget {
  backend: string;
  store: string;
  endpoint?: string;
  username?: string;
  password?: string;
  configurationKind: string;
  configPath?: string;
  source?: {
    namespace?: string;
    pod?: string;
    container?: string;
  };
}

export interface ServiceVdbConfigurationInput {
  environment: Readonly<Record<string, string>>;
  file?: {
    path: string;
    content: string;
  };
}

export interface ServiceVdbConfiguration {
  /** Doctor 负责读取文件；路径规则及文件内容语义由 Plugin 拥有。 */
  file?: {
    pathEnvironment: string;
    defaultPath: string;
  };
  resolve(
    input: ServiceVdbConfigurationInput,
  ): ServiceVdbTarget | Promise<ServiceVdbTarget>;
}

export interface ServiceVdbStoreCapability extends ServiceStoreCapabilityBase {
  kind: "vdb";
  backend: "opensearch";
  store?: string;
  /** Plugin 自行发现配置来源并投影出统一 VDB target；Core 只提供受控上下文。 */
  inspectTarget?(context: PluginContext): Promise<ServiceVdbTarget>;
  access?: CapabilityWithAccess["access"];
  /** 非标准 VDB 配置由 Plugin 投影为 Doctor 可消费的统一 target。 */
  configuration?: ServiceVdbConfiguration;
}

export interface ServiceS3StoreCapability extends ServiceStoreCapabilityBase {
  kind: "s3";
  backend: "s3-compatible";
  environment: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucketPrefix?: string;
    addressStyle?: string;
  };
}

export interface ServiceRedisStoreCapability extends ServiceStoreCapabilityBase {
  kind: "redis";
  backend: "redis";
  environment: {
    address: string;
    port?: string;
    database?: string;
    username?: string;
    password?: string;
    useSsl?: string;
    clusterType?: string;
    sentinels?: string;
    sentinelMasterName?: string;
    sentinelUsername?: string;
    sentinelPassword?: string;
    timeout?: string;
  };
}

export type ServiceStoreCapability =
  | ServiceDatabaseStoreCapability
  | ServiceVdbStoreCapability
  | ServiceS3StoreCapability
  | ServiceRedisStoreCapability;

/** Service 构建与运行所使用的稳定工具链声明；现场版本仍由 Doctor 从 Target 观测。 */
export interface Toolchain {
  language: "python" | "go" | "javascript" | "typescript" | "java" | "kotlin";
  executionPlatform: "python" | "go-native" | "node" | "jvm";
  dependencyManager?:
    | "pip"
    | "poetry"
    | "uv"
    | "go-modules"
    | "npm"
    | "pnpm"
    | "yarn"
    | "maven"
    | "gradle";
  buildTool?: "go" | "tsc" | "vite" | "webpack" | "maven" | "gradle";
}

const TOOLCHAIN_VALUES = {
  language: new Set<string>(["python", "go", "javascript", "typescript", "java", "kotlin"]),
  executionPlatform: new Set<string>(["python", "go-native", "node", "jvm"]),
  dependencyManager: new Set<string>([
    "pip", "poetry", "uv", "go-modules", "npm", "pnpm", "yarn", "maven", "gradle",
  ]),
  buildTool: new Set<string>(["go", "tsc", "vite", "webpack", "maven", "gradle"]),
} as const;

/** Validate the optional Toolchain across the untyped Plugin ESM boundary. */
export function isToolchain(value: unknown): value is Toolchain {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.language === "string"
    && TOOLCHAIN_VALUES.language.has(candidate.language)
    && typeof candidate.executionPlatform === "string"
    && TOOLCHAIN_VALUES.executionPlatform.has(candidate.executionPlatform)
    && (candidate.dependencyManager === undefined
      || (typeof candidate.dependencyManager === "string"
        && TOOLCHAIN_VALUES.dependencyManager.has(candidate.dependencyManager)))
    && (candidate.buildTool === undefined
      || (typeof candidate.buildTool === "string" && TOOLCHAIN_VALUES.buildTool.has(candidate.buildTool)));
}

export interface ServiceCapabilities {
  stores?: readonly ServiceStoreCapability[];
  config?: Record<string, never>;
  log?: {
    default: boolean;
  };
  traceId?: ServiceTraceIdCapability;
  tenantDirectory?: ServiceTenantDirectoryCapability;
  modelCatalog?: ServiceModelCatalogCapability;
  inference?: ServiceInferenceCapability;
  case?: ServiceCaseCapability;
  perf?: ServicePerfCapability;
  metric?: ServiceMetricCapability;
  mcp?: ServiceMcpCapability;
}

export type ServiceCapabilityName = keyof ServiceCapabilities;

/** A Service-level dependency on one Store capability exposed by another Service. */
export interface ServiceStoreCapabilityDependency {
  /** Stable local name used by this Service to consume the resolved dependency. */
  id: string;
  service: string;
  capability: "stores";
  store: string;
}

/** Extend this union when another capability gains a concrete runtime dependency contract. */
export type ServiceCapabilityDependency = ServiceStoreCapabilityDependency;

export interface ServiceRelationship {
  kind: "managed-by";
  service: string;
}

/** Doctor 跨 Plugin 共用的 Service 元描述；具体 Plugin 只声明身份和 capability。 */
export interface ServiceDefinition {
  name: string;
  /** Explicit deployment topology. An empty list means this Service has no runtime workload. */
  workloads: readonly ServiceWorkloadDefinition[];
  relationships?: readonly ServiceRelationship[];
  toolchain?: Toolchain;
  /**
   * Runtime capabilities this Service requires from other Services in the same Plugin.
   * This stays Service-scoped because capability ownership and connection-config ownership may differ.
   */
  dependencies?: readonly ServiceCapabilityDependency[];
  /** Inspect, Probe and Detector contributions selected and driven by Core Collect commands. */
  contributions?: ServiceContributions;
  capabilities: ServiceCapabilities;
}
