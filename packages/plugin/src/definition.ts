import type { PluginContext } from "./context";
import type {
  ServiceHttpResponse,
} from "./http";
import type { HttpTransportResponse } from "./http";
import type { ServiceCatalog } from "./catalog";
import type { ServiceDataTarget } from "./service";
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

export interface Model {
  id: string;
  name: string;
  type: ModelType;
  provider: string;
  vendor?: string;
  version?: string;
  metaData?: {
    apiBase?: string;
    endpointId?: string;
  };
}

export interface ModelBackend extends Record<string, unknown> {
  ModelID: string;
  ModelName: string;
  Model: string;
  Type: string;
  Provider: string;
}

export interface ModelCatalog {
  listAvailable(tenantId: string, type?: ModelType): Promise<Model[]>;
  getBackend(modelId: string): Promise<ModelBackend | undefined>;
}

export interface ModelInference {
  validate(backend: ModelBackend): Promise<ServiceHttpResponse>;
  invoke(path: string, body: Record<string, unknown>): Promise<ServiceHttpResponse>;
  invokeStream(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HttpTransportResponse>;
}

export interface ModelDiagnosisCapability {
  catalogService: string;
  inferenceService: string;
}

export interface TenantConfigurationCapability {
  /** 顺序从低优先级到高优先级，后一个 scope 覆盖前一个。 */
  scopes: readonly string[];
  directoryService: string;
  databaseService: string;
  createReader(context: PluginContext): Promise<TenantConfigReader>;
}

/** CLI 选择一个业务 Plugin；collect 只消费这里暴露的 Catalog 与插件级可选能力。 */
export interface PluginDefinition {
  id: string;
  services: ServiceCatalog;
  tenantConfiguration?: TenantConfigurationCapability;
  modelDiagnosis?: ModelDiagnosisCapability;
  traceDiagnosis?: {
    specs: SpecSet;
    /** 提供 Trace OpenSearch 运行时连接配置的业务 Service Store。 */
    openSearchStore?: {
      service: string;
      store: string;
    };
  };
}
