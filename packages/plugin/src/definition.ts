import type { TraceContributions } from "@compforge/trace-harness";
import type { Identity, Query } from "./capability";
import type {
  ServiceHttpResponse,
} from "./http";
import type { HttpTransportResponse } from "./http";
import type { ServiceCatalog } from "./catalog";
import type { ExtensionRegistration } from "./extension/registry";
import type {
  PluginSkill,
  PreparedSkillContext,
  SkillExecutionTarget,
} from "./skill";

export type ModelType = "llm" | "embedding" | "rerank" | "audio";
export type ModelInputModality = "text" | "image" | "audio";

export interface ModelInferenceTarget {
  baseUrl: string;
  model: string;
}

export interface ModelPricing {
  input: number;
  output: number;
  unit: string;
  currency: string;
  type: string;
}

export interface Model {
  id: string;
  name: string;
  type: ModelType;
  provider: string;
  vendor?: string;
  version?: string;
  description?: string;
  available?: boolean;
  preset?: boolean;
  billing?: boolean;
  sourceModelId?: string;
  contextLength?: string;
  dimension?: number;
  /** Catalog-declared input modalities; consumers must not infer them from names or vendors. */
  inputModalities?: readonly ModelInputModality[];
  /** Catalog-declared model features/capacities, kept as opaque stable names for reporting. */
  capacities?: readonly string[];
  features?: readonly string[];
  pricing?: ModelPricing;
  createdAt?: string;
  updatedAt?: string;
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
  query(query: Query<TenantIdentity, { type?: ModelType }>): Promise<Model[]>;
  getBackend(model: Model): Promise<ModelBackendHandle | undefined>;
}

export interface TenantIdentity extends Identity {
  kind: "tenant_id";
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

export interface TraceCapability {
  /** 本地 span 归一化、分类/融合及 Trace IR 分析扩展；不参与 Target 访问或远端采集。 */
  analysis: TraceContributions;
  /** Core 采集 trace 时使用的业务数据源声明。 */
  source?: {
    dataSource: {
      service: string;
      dataSource: string;
    };
  };
}

/** Plugin identity names one immutable code-and-Skills distribution. */
export interface PluginIdentity {
  id: string;
  version: string;
}

/**
 * Plugin 是多个 Service 与 Skill 共享版本、安装和选择生命周期的分发单元。
 *
 * @spec Plugin identity、Service、Skill 与业务 capability 共享同一版本和选择生命周期
 * @case id=plugin_distribution_unit,desc=`装配完整 Plugin`,expect=`Service 与 Skill 来自同一 Plugin 版本`,forbid=`独立选择或升级 Skill`
 * @see {@link cli/docs/plugin.md}
 * @rule 新增 Plugin 级资源时，先判断它是否应跟随 Plugin 生命周期
 */
export interface PluginDefinition extends PluginIdentity {
  /** 一个应用可由同一 Plugin 中的多个 Service 共同描述。 */
  services: ServiceCatalog;
  /** Offline resources registered by the Plugin, independent of Service runtime access. */
  extensions?: readonly ExtensionRegistration[];
  trace?: TraceCapability;
  /** Runtime-resolved Skills from the same exact Plugin version. */
  skills?: readonly PluginSkill[];
  /** Validate the opaque profile config before Doctor prepares target access for a command. */
  validateConfig?(config: Readonly<Record<string, unknown>>): void;
  /** Prepare target-specific access facts consumed by this Plugin's Skill scripts. */
  prepareSkillContext?(
    target: SkillExecutionTarget,
  ): PreparedSkillContext | Promise<PreparedSkillContext>;
}
