import type { DbCredentials } from "../../protocol";

/** Redis 在全局 YAML profile 中提供的原始配置。 */
export interface RedisProfileConfig {
  url?: string;
  username?: string;
  password?: string;
  pod?: string;
  /** 兼容旧 profile；新配置使用 pod。 */
  deployment?: string;
  cluster_type?: "single" | "sentinel" | "cluster";
}

export interface RegistryProfileConfig {
  username?: string;
  password?: string;
}

export interface PrometheusProfileConfig {
  url: string;
  username?: string;
  password?: string;
  timeout_ms?: number;
  max_response_bytes?: number;
}

export interface PluginProfileConfig {
  /** Opaque Plugin-owned config; Core stores and forwards it without interpreting the schema. */
  config?: Readonly<Record<string, unknown>>;
}

/** ~/.doctor/config.yaml 中的单个 profile。 */
export interface Profile {
  // 未配 server = 本地 profile：不连 doctor-server，凭本地 kubectl 直连采集；
  // 本地 agent loop 后续同样以是否配置 server 分流。
  server?: string;
  readonly: boolean;
  namespace?: string;
  db?: DbCredentials;
  redis?: RedisProfileConfig;
  /** doctor debug 向目标 registry 发布诊断镜像时使用的身份。 */
  registry?: RegistryProfileConfig;
  /** Prefer an existing Prometheus for metric history; omit to use embedded Prombed scraping. */
  prometheus?: PrometheusProfileConfig;
  plugin?: PluginProfileConfig;
  kube?: {
    kubeconfig_path?: string;
    /** memd 在业务容器缺少 gdb 时使用的临时调试容器镜像。 */
    debug_image?: string;
  };
  llm?: { provider?: string; endpoint?: string; api_key?: string; model?: string; thinking?: boolean };
}

/** ~/.doctor/config.yaml 解析后的全局配置模型。 */
export interface Config {
  default_profile?: string;
  profiles: Record<string, Profile>;
}
