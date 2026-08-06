import type { PluginContext } from "./context";
import type {
  ModelCatalog,
  ModelInference,
  ModelInferenceTarget,
} from "./definition";
import type { ServiceMcpCapability } from "./mcp";

export interface TenantSummary {
  id: string;
  name: string;
  displayName: string;
}

export interface TenantDirectory {
  listActive(): Promise<TenantSummary[]>;
  getByName(name: string): Promise<TenantSummary>;
}

export interface ServiceTenantDirectoryCapability {
  create(context: PluginContext): TenantDirectory;
}

export interface ServiceModelCatalogCapability {
  create(context: PluginContext): ModelCatalog;
}

export interface ServiceInferenceCapability {
  create(
    context: PluginContext,
    target: ModelInferenceTarget,
    timeoutMs: number,
  ): ModelInference;
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

export interface ServiceDataCapability {
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
}

/** 把 Plugin 认识的业务 ID 解析为 Doctor trace/log 消费的规范 trace_id。 */
export interface ServiceTraceIdCapability {
  resolve(
    context: PluginContext,
    input: ServiceTraceIdInput,
  ): Promise<ServiceTraceIdResolution | undefined>;
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
  metric?: ServiceMetricCapability;
  mcp?: ServiceMcpCapability;
}

/** Doctor 跨 Plugin 共用的 Service 元描述；具体 Plugin 只声明身份和 capability。 */
export interface ServiceDefinition {
  name: string;
  port?: number;
  capabilities: ServiceCapabilities;
}
