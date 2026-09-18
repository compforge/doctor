import { describeService, type PluginDefinition, type ServiceDescription } from "@compforge/doctor-plugin";
import { loadActivePlugin, pluginInstallRoot } from "./loader";

export interface PluginSummary {
  id: string;
  version: string;
  source: "injected" | "installed";
  services: ServiceDescription[];
}

/**
 * @spec 发现与 Command 使用相同的 Plugin 优先级：入口注入优先，否则加载 Host active 版本。
 * 这里只投影 Catalog 声明，不执行 capability、配置校验或目标访问；不代表现场 Service 健康或可达。
 */
export function listPlugins(injected?: PluginDefinition, installRoot?: string): Promise<PluginSummary[]>;
export function listPlugins<T extends ServiceDescription>(
  injected: PluginDefinition | undefined, installRoot: string | undefined,
  describeServices: (plugin: PluginDefinition) => T[],
): Promise<(Omit<PluginSummary, "services"> & { services: T[] })[]>;
export async function listPlugins(
  injected?: PluginDefinition,
  installRoot = pluginInstallRoot(),
  describeServices = (plugin: PluginDefinition): ServiceDescription[] => plugin.services.services.map(describeService),
): Promise<PluginSummary[]> {
  const plugin = injected ?? await loadActivePlugin(installRoot);
  if (!plugin) return [];
  return [{
    id: plugin.id,
    version: plugin.version,
    // 注入也可能来自调用方的动态加载，不能推断它一定是内嵌代码。
    source: injected ? "injected" : "installed",
    services: describeServices(plugin),
  }];
}
