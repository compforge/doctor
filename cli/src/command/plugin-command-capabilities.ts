import { DATA_ID_KIND } from "@compforge/doctor-plugin";
import type { PluginCapabilityContract, PluginCapabilityNeed } from "./plugin-capability";
import type { CollectKind } from "../collect/composite";

/** Plugin command 在接触环境前声明的静态业务能力；依赖 flags 的条件能力由对应 command 延迟检查。 */
export const PLUGIN_COMMAND_CAPABILITIES = {
  health: {
    command: "doctor health",
    // Exact Probe/DataSource/Case discovery runs before environment preparation.
    needs: [],
  },
  overview: {
    command: "doctor overview",
    // Statistics are required; sampling is optional and stays in the same namespace.
    needs: [],
  },
  trace: {
    command: "doctor trace",
    needs: [{
      requirement: "required",
      capability: { scope: "extension", name: "trace.resolve" },
      purpose: "把业务 ID 解析为规范 trace_id",
    }],
  },
  traceRange: {
    command: "doctor trace",
    needs: [{
      requirement: "required",
      capability: { scope: "extension", name: "trace.range" },
      purpose: "在业务时间范围内选择规范 trace_id",
    }],
  },
  store: {
    command: "doctor store",
    needs: [{
      requirement: "required",
      capability: { scope: "resource", name: "dataSources" },
      purpose: "定位业务 Store 并解释其运行时配置",
    }],
  },
  log: {
    command: "doctor log",
    needs: [{
      requirement: "required",
      capability: { scope: "resource", name: "logs" },
      purpose: "声明需要采集日志的业务 Service",
    }],
  },
  data: {
    command: "doctor data",
    needs: [{
      requirement: "required",
      capability: { scope: "extension", name: DATA_ID_KIND },
      purpose: "定位业务数据源并返回约定数据",
    }],
  },
  inspect: {
    command: "doctor inspect",
    needs: [],
  },
  tenant: {
    command: "doctor tenant",
    needs: [{ requirement: "required", capability: { scope: "extension", name: "data.page" }, purpose: "查询租户数据" }],
  },
  mcp: {
    command: "doctor mcp",
    needs: [{
      requirement: "required",
      capability: { scope: "extension", name: "mcp.configuration" },
      purpose: "定位业务 MCP server 并解释工具语义",
    }],
  },
  eval: {
    command: "doctor eval",
    needs: [{
      requirement: "required",
      capability: { scope: "resource", name: "cases" },
      purpose: "提供 canonical CaseSet、单次请求触发和协议判定",
    }, {
      requirement: "preferred",
      capability: { scope: "extension", name: "trace.resolve" },
      purpose: "把 Case Observation 的业务关联 ID 解析为 trace_id",
      fallback: "保留 Case Observation，继续采集可用的 Log / Data，跳过 Trace",
    }, {
      requirement: "preferred",
      capability: { scope: "resource", name: "logs" },
      purpose: "采集 Case 关联的业务日志",
      fallback: "跳过 Log 证据",
    }, {
      requirement: "preferred",
      capability: { scope: "extension", name: DATA_ID_KIND },
      purpose: "采集 Case 关联的业务 Facts/Relations",
      fallback: "跳过业务 Data 证据",
    }],
  },
  perf: {
    command: "doctor perf",
    needs: [{requirement: "required", capability: {scope: "resource", name: "cases"},
      purpose: "提供 Case 资产和静态 Operation 观测入口"}],
  },
} as const satisfies Record<string, PluginCapabilityContract>;

/** collect 只组合所选具体命令的 capability contract，不拥有新的业务能力。 */
export function collectPluginCapabilities(kinds: readonly CollectKind[]): PluginCapabilityContract {
  const needs: PluginCapabilityNeed[] = [];
  for (const kind of kinds) {
    for (const need of PLUGIN_COMMAND_CAPABILITIES[kind].needs) {
      const existingIndex = needs.findIndex((candidate) => (
        candidate.capability.scope === need.capability.scope
        && candidate.capability.name === need.capability.name
      ));
      if (existingIndex === -1) {
        needs.push(need);
      } else if (
        needs[existingIndex]?.requirement === "preferred"
        && need.requirement === "required"
      ) {
        needs[existingIndex] = need;
      }
    }
  }
  return {
    command: "doctor collect",
    needs,
  };
}
