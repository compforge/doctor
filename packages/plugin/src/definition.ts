import type { PluginContext } from "./context";
import type {
  ServiceHttpResponse,
} from "./http";
import type { HttpTransportResponse } from "./http";
import type { ServiceCatalog } from "./catalog";
import type { ServiceDataTarget } from "./service";
import type { PluginSkill } from "./skill";
import type { SpecSet } from "@compforge/trace-harness";

export interface TenantConfigTarget {
  service: string;
  port: number;
}

export interface TenantConfigReader {
  target: ServiceDataTarget;
  loadTenantConfig(
    tenantId: string,
    scope: string,
  ): Promise<Record<string, unknown>>;
}

export type ModelType = "llm" | "embedding" | "rerank" | "audio";

export interface ModelInferenceTarget {
  baseUrl: string;
  model: string;
}

export interface Model {
  id: string;
  name: string;
  type: ModelType;
  provider: string;
  vendor?: string;
  version?: string;
  inference?: Partial<ModelInferenceTarget>;
}

/** Plugin 持有的临时 backend handle；原始厂商配置和凭据不穿透到 Core。 */
export interface ModelBackendHandle {
  modelId: string;
  modelName: string;
  model: string;
  type: string;
  provider: string;
  validate(timeoutMs: number): Promise<ServiceHttpResponse>;
}

export interface ModelCatalog {
  listAvailable(tenantId: string, type?: ModelType): Promise<Model[]>;
  getBackend(model: Model): Promise<ModelBackendHandle | undefined>;
}

export interface ModelInference {
  invoke(path: string, body: Record<string, unknown>): Promise<ServiceHttpResponse>;
  invokeStream(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HttpTransportResponse>;
}

export interface ModelDiagnosisCapability {
  tenantDirectoryService: string;
  catalogService: string;
  inferenceService: string;
}

export interface TraceDiagnosisCapability {
  specs: SpecSet;
  /** 提供 Trace OpenSearch 运行时连接配置的业务 Service Store。 */
  openSearchStore?: {
    service: string;
    store: string;
  };
}

export interface TenantConfigurationCapability {
  /** 顺序从低优先级到高优先级，后一个 scope 覆盖前一个。 */
  scopes: readonly string[];
  directoryService: string;
  databaseService: string;
  createReader(context: PluginContext): Promise<TenantConfigReader>;
}

/** 不属于单个 Service、但仍由 Plugin 提供的业务语义。 */
export interface PluginLevelCapabilities {
  tenantConfiguration?: TenantConfigurationCapability;
  modelDiagnosis?: ModelDiagnosisCapability;
  traceDiagnosis?: TraceDiagnosisCapability;
}

export type PluginLevelCapabilityName = keyof PluginLevelCapabilities;

/** CLI 选择一个业务 Plugin；collect 只消费这里暴露的 Catalog 与 Plugin capability。 */
export interface PluginDefinition extends PluginLevelCapabilities {
  id: string;
  services: ServiceCatalog;
  /** Runtime-resolved Skills from the same exact Plugin version. */
  skills?: readonly PluginSkill[];
}
