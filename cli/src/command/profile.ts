export interface DbCredentials {
  user: string;
  password: string;
  host_override?: string;
  port_override?: number;
}

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

/** A validated profile selected once for one Doctor command. */
export interface Profile {
  server?: string;
  readonly: boolean;
  namespace?: string;
  db?: DbCredentials;
  redis?: RedisProfileConfig;
  registry?: RegistryProfileConfig;
  prometheus?: PrometheusProfileConfig;
  plugin?: PluginProfileConfig;
  kube?: {
    kubeconfig_path?: string;
    debug_image?: string;
  };
  llm?: {
    provider?: string;
    endpoint?: string;
    api_key?: string;
    model?: string;
    thinking?: boolean;
  };
}

export interface Config {
  default_profile?: string;
  profiles: Record<string, Profile>;
}
