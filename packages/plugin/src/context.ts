import type { DatabaseIdentity } from "./database";
import type { KubernetesAccess } from "./kubernetes";

/**
 * Doctor 在一次 capability 调用中确认的运行态事实。
 *
 * Plugin 拥有业务目标与数据语义；Kubernetes 传输和 port-forward 生命周期由 Doctor 托管。
 * Plugin 仍是同进程受信任代码，这个接口是职责边界而不是安全沙箱。
 */
export interface PluginTarget {
  env: string;
  namespace: string;
  service: {
    name: string;
    port?: number;
  };
}

export interface PluginInfra {
  kubernetes: KubernetesAccess;
  /** Profile 中显式配置的数据库身份，仅作为 Service 运行时配置的兜底。 */
  databaseIdentity?: DatabaseIdentity;
}

export interface PluginContext {
  target: PluginTarget;
  /** Profile-scoped opaque config. Its schema and interpretation belong to the Plugin. */
  config: Readonly<Record<string, unknown>>;
  infra: PluginInfra;
  signal: AbortSignal;
  onDispose(disposer: () => void | Promise<void>): void;
}
