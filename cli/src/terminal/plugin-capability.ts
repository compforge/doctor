import type { PluginDefinition } from "@compforge/doctor-plugin";
import {
  evaluatePluginCapabilities,
  pluginCapabilityLabel,
  type PluginCapabilityContract,
} from "../command/plugin-capability";

import { useLogger } from "./log";

/** Plugin capability 在访问 Kubernetes 前检查，避免把业务能力缺失误报成环境故障。 */
export function requirePluginCapabilities(
  plugin: PluginDefinition | undefined,
  contract: PluginCapabilityContract,
): PluginDefinition {
  const evaluation = evaluatePluginCapabilities(plugin, contract);
  if (!plugin) {
    throw new Error(
      `[plugin] ${contract.command} 需要 Doctor Host 加载 Plugin；`
      + "请先运行 doctor plugin install <archive>",
    );
  }

  for (const fact of evaluation.facts) {
    const label = pluginCapabilityLabel(fact.need.capability);
    if (fact.available) {
      useLogger("plugin").success(`${fact.need.requirement}: ${label} ✓`
        + `（${fact.need.purpose}；providers=${fact.providers.join(",")}）`);
      continue;
    }
    const fallback = fact.need.fallback ? `；${fact.need.fallback}` : "";
    useLogger("plugin").warn(`${fact.need.requirement}: ${label} missing`
      + `（${fact.need.purpose}）${fallback}`);
  }

  if (!evaluation.runnable) {
    const missing = evaluation.facts
      .filter((fact) => fact.need.requirement === "required" && !fact.available)
      .map((fact) => pluginCapabilityLabel(fact.need.capability))
      .join("、");
    throw new Error(
      `[plugin] ${contract.command} 缺少必须的 Plugin capability：${missing}；`
      + `Plugin '${plugin.id}' 未提供对应业务目标或数据语义`,
    );
  }
  return plugin;
}
