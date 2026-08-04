import type { DatabaseIdentity } from "./database";
import type { HttpServiceTarget } from "./http";

/**
 * Doctor 在一次 capability 调用中确认的运行态事实。
 *
 * Plugin 是同进程受信任代码，可以自行访问网络、文件和 Kubernetes；这里不是沙箱，
 * 也不规定 Plugin 内部如何实现 Service 访问。portForward/onDispose 只是由 Doctor 托管生命周期的便利能力。
 */
export interface PluginContext {
  profileName: string;
  /** Profile 中显式配置的数据库身份，仅作为 Service 运行时配置的兜底。 */
  databaseIdentity?: DatabaseIdentity;
  kubeconfig?: string;
  kubeContext?: string;
  namespace: string;
  service: {
    name: string;
    port?: number;
    pod?: string;
    container?: string;
    /** Doctor 已取得的当前 Service 环境；Plugin 也可忽略它并自行访问 Kubernetes。 */
    environment?: Readonly<Record<string, string>>;
  };
  signal: AbortSignal;
  portForward(target: HttpServiceTarget): Promise<HttpServiceTarget & { servername?: string }>;
  onDispose(disposer: () => void | Promise<void>): void;
}
