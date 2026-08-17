import type { PluginContext } from "./context";
import type {
  ModelCatalog,
  ModelInference,
  ModelInferenceTarget,
} from "./definition";
import type { ServiceMcpCapability } from "./mcp";
import type { CapabilityWithAccess } from "./kubernetes";

export interface ServiceEndpoint {
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

/** Service-owned Prometheus contract consumed by doctor metric. */
export interface ServiceMetricCapability {
  endpoint: { port: number; path: string };
  /** Limits embedded scraping to the metric families required by this declaration. */
  metricNames: readonly string[];
  charts: readonly ServiceMetricChart[];
  detectors?: readonly ServiceMetricDetector[];
}

/** Runtime projection of a canonical spec-case Case asset; this interface does not own its schema. */
export interface ServiceCaseAsset {
  id: string;
  input: Readonly<Record<string, unknown>>;
  facets?: Readonly<Record<string, string>>;
}

/** Controlled vocabulary for one canonical Case facet. */
export interface ServiceCaseFacetSpec {
  values?: readonly string[];
  ordered?: boolean;
  open?: boolean;
}

export interface ServiceCaseSet {
  id: string;
  title: string;
  description?: string;
  facets?: Readonly<Record<string, ServiceCaseFacetSpec>>;
  cases: readonly ServiceCaseAsset[];
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

export interface ServiceCaseTrialContext {
  runId: string;
  signal: AbortSignal;
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
export interface ServiceCaseRunner {
  setup?(context: ServiceCaseTrialContext): Promise<void>;
  trigger(input: {
    case: ServiceCaseAsset;
    runId: string;
    signal: AbortSignal;
  }): Promise<ServiceCaseObservation>;
  /** Pure per-request protocol classification; aggregate Case/Perf judgment stays outside the runner. */
  classify(observation: ServiceCaseObservation): ServiceCaseVerdict;
  /** Stop accepting new protocol work after Core has stopped dispatching this Trial. */
  deactivate?(context: ServiceCaseTrialContext): Promise<void>;
  /** Release per-Trial protocol resources; Core attempts this even when setup/trigger fails. */
  cleanup?(context: ServiceCaseTrialContext): Promise<void>;
}

/** Service-owned single-Case trigger consumed by Case Harness and Perf Harness callers. */
export interface ServiceCaseCapability extends CapabilityWithAccess {
  endpoint: ServiceEndpoint;
  caseSets: readonly ServiceCaseSet[];
  requestIdentity?: ServiceCaseIdentityRequirement;
  createRunner(
    context: PluginContext,
    input: { caseSetId: string; timeoutMs: number; requestIdentity?: ServiceRequestIdentity },
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

export interface ServiceDataResult {
  kind: string;
  service: string;
  resolution: {
    inputId: string;
    resolvedAs: string;
  };
}

export interface ServiceDataSummary {
  resolvedAs: string;
  identifiers: Readonly<Record<string, string | undefined>>;
}

export interface ServiceDataFinding {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  confidence: "low" | "medium" | "high";
  message: string;
  [name: string]: unknown;
}

export interface ServiceDataInput {
  inputId: string;
  results: ReadonlyMap<string, readonly ServiceDataResult[]>;
}

/** Plugin 返回给 Doctor 展示和判定数据访问是否可用的脱敏结果。 */
export interface ServiceDataTarget {
  endpoint: string;
  database: string;
  username: string;
  credentialSource: string;
}

export interface ServiceDataCapability extends CapabilityWithAccess {
  /** 此 Service 可共享的稳定业务数据类型，用于 Catalog 展示与能力发现。 */
  provides: readonly string[];
  /** 存在时表示此 Service 还可扩展这些规范 ID 类型。 */
  expands?: readonly string[];
  /** 直接访问 Store 时声明 Store ID；通过 Service API 查询时可省略。 */
  store?: string;
  inspectTarget(context: PluginContext): Promise<ServiceDataTarget>;
  inspect(context: PluginContext, input: ServiceDataInput): Promise<ServiceDataResult>;
  summarize(result: ServiceDataResult): ServiceDataSummary;
  detect(result: ServiceDataResult): ServiceDataFinding[];
}

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
  data?: ServiceDataCapability;
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

/** Doctor 跨 Plugin 共用的 Service 元描述；具体 Plugin 只声明身份和 capability。 */
export interface ServiceDefinition {
  name: string;
  toolchain?: Toolchain;
  /**
   * Runtime capabilities this Service requires from other Services in the same Plugin.
   * This stays Service-scoped because capability ownership and connection-config ownership may differ.
   */
  dependencies?: readonly ServiceCapabilityDependency[];
  capabilities: ServiceCapabilities;
}
