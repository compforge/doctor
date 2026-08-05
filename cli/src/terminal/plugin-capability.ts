import type { PluginDefinition } from "@compforge/doctor-plugin";
import {
  evaluatePluginCapabilities,
  pluginCapabilityLabel,
  type PluginCapabilityContract,
} from "../command/plugin-capability";
import { terminalStdout } from "./output";

/** Plugin capability 在访问 Kubernetes 前检查，避免把业务能力缺失误报成环境故障。 */
export function requirePluginCapabilities(
  plugin: PluginDefinition | undefined,
  contract: PluginCapabilityContract,
): PluginDefinition {
  const evaluation = evaluatePluginCapabilities(plugin, contract);
  if (!plugin) {
    throw new Error(
      `[plugin] ${contract.command} 需要当前 profile 选择 Plugin；`
      + "Plugin 负责提供业务目标和数据语义",
    );
  }

  for (const fact of evaluation.facts) {
    const label = pluginCapabilityLabel(fact.need.capability);
    if (fact.available) {
      terminalStdout.success(
        `[plugin] ${fact.need.requirement}: ${label} ✓`
        + `（${fact.need.purpose}；providers=${fact.providers.join(",")}）\n`,
      );
      continue;
    }
    const fallback = fact.need.fallback ? `；${fact.need.fallback}` : "";
    terminalStdout.warning(
      `[plugin] ${fact.need.requirement}: ${label} missing`
      + `（${fact.need.purpose}）${fallback}\n`,
    );
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
