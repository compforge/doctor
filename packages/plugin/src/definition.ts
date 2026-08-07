import type { PluginContext } from "./context";
import type {
  ServiceHttpResponse,
} from "./http";
import type { HttpTransportResponse } from "./http";
import type { ServiceCatalog } from "./catalog";
import type { ServiceDataTarget } from "./service";
import type {
  PluginSkill,
  PreparedSkillContext,
  SkillExecutionTarget,
} from "./skill";
import type { CapabilityWithAccess } from "./kubernetes";

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

/** Plugin-owned inference handle; LLM chat uses the OpenAI-compatible chat completions path. */
export interface ModelInference {
  invoke(path: string, body: Record<string, unknown>): Promise<ServiceHttpResponse>;
  invokeStream(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HttpTransportResponse>;
}

/** Services that together provide model discovery and OpenAI-compatible inference. */
export interface ModelCapability {
  tenantDirectoryService: string;
  catalogService: string;
  inferenceService: string;
}

/** Trace rules stay opaque to the Plugin protocol; the Trace collector adapts the iterable. */
export type TraceSpecCollection = Iterable<unknown>;

export interface TraceDiagnosisCapability {
  specs: TraceSpecCollection;
  /** 提供 Trace OpenSearch 运行时连接配置的业务 Service Store。 */
  openSearchStore?: {
    service: string;
    store: string;
  };
}

export interface TenantConfigurationCapability extends CapabilityWithAccess {
  /** 顺序从低优先级到高优先级，后一个 scope 覆盖前一个。 */
  scopes: readonly string[];
  directoryService: string;
  databaseService: string;
  createReader(context: PluginContext): Promise<TenantConfigReader>;
}

/** 不属于单个 Service、但仍由 Plugin 提供的业务语义。 */
export interface PluginLevelCapabilities {
  tenantConfiguration?: TenantConfigurationCapability;
  model?: ModelCapability;
  traceDiagnosis?: TraceDiagnosisCapability;
}

export type PluginLevelCapabilityName = keyof PluginLevelCapabilities;

/** Plugin identity names one immutable code-and-Skills distribution. */
export interface PluginIdentity {
  id: string;
  version: string;
}

/** Plugin 是多个 Service 与 Skill 共享版本、安装和选择生命周期的分发单元。 */
export interface PluginDefinition extends PluginIdentity, PluginLevelCapabilities {
  /** 一个应用可由同一 Plugin 中的多个 Service 共同描述。 */
  services: ServiceCatalog;
  /** Runtime-resolved Skills from the same exact Plugin version. */
  skills?: readonly PluginSkill[];
  /** Validate the opaque profile config before Doctor prepares target access for a command. */
  validateConfig?(config: Readonly<Record<string, unknown>>): void;
  /** Prepare target-specific access facts consumed by this Plugin's Skill scripts. */
  prepareSkillContext?(
    target: SkillExecutionTarget,
  ): PreparedSkillContext | Promise<PreparedSkillContext>;
}
