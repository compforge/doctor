import type { PluginDefinition } from "@compforge/doctor-plugin";
import { loadActivePlugin, pluginInstallRoot } from "./loader";

export interface PluginSummary {
  id: string;
  version: string;
  source: "injected" | "installed";
  services: {
    name: string;
    capabilities: string[];
    contributions: string[];
  }[];
}

/**
 * @spec 发现与 Command 使用相同的 Plugin 优先级：入口注入优先，否则加载 Host active 版本。
 * 这里只投影 Catalog 声明，不执行 capability、配置校验或目标访问；不代表现场 Service 健康或可达。
 */
export async function listPlugins(
  injected?: PluginDefinition,
  installRoot = pluginInstallRoot(),
): Promise<PluginSummary[]> {
  const plugin = injected ?? await loadActivePlugin(installRoot);
  if (!plugin) return [];
  return [{
    id: plugin.id,
    version: plugin.version,
    // 注入也可能来自调用方的动态加载，不能推断它一定是内嵌代码。
    source: injected ? "injected" : "installed",
    services: plugin.services.services.map(service => ({
      name: service.name,
      capabilities: Object.entries(service.capabilities)
        .filter(([, value]) => value !== undefined).map(([name]) => name),
      contributions: Object.entries(service.contributions ?? {})
        .filter(([, value]) => value !== undefined).map(([name]) => name),
    })),
  }];
}
