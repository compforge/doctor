import type { PluginCapabilityContract, PluginCapabilityNeed } from "../command";
import type { CollectKind } from "../collect/composite";

/** Plugin command 在接触环境前声明的静态业务能力；依赖 flags 的条件能力由对应 command 延迟检查。 */
export const PLUGIN_COMMAND_CAPABILITIES = {
  trace: {
    command: "doctor trace",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "traceId" },
      purpose: "把业务 ID 解析为规范 trace_id",
    }],
  },
  store: {
    command: "doctor store",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "stores" },
      purpose: "定位业务 Store 并解释其运行时配置",
    }],
  },
  log: {
    command: "doctor log",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "log" },
      purpose: "声明需要采集日志的业务 Service",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "traceId" },
      purpose: "把业务 ID 解析为规范 trace_id",
    }],
  },
  data: {
    command: "doctor data",
    needs: [{
      requirement: "required",
      capability: { scope: "contribution", name: "inspect" },
      purpose: "定位业务数据源并返回约定数据",
    }],
  },
  inspect: {
    command: "doctor inspect",
    needs: [],
  },
  tenant: {
    command: "doctor tenant",
    needs: [{
      requirement: "required",
      capability: { scope: "plugin", name: "tenant" },
      purpose: "声明租户身份解析入口",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "tenantDirectory" },
      purpose: "解析要 Inspect 的租户",
    }, {
      requirement: "preferred",
      capability: { scope: "plugin", name: "model" },
      purpose: "声明可复用的模型目录",
      fallback: "仅汇总接受 tenant_id 的业务数据",
    }, {
      requirement: "preferred",
      capability: { scope: "service", name: "modelCatalog" },
      purpose: "查询租户可用模型 Facts",
      fallback: "跳过模型目录",
    }, {
      requirement: "preferred",
      capability: { scope: "contribution", name: "inspect" },
      purpose: "查询接受 tenant_id 的业务 Facts",
      fallback: "仅汇总租户身份与模型目录",
    }],
  },
  mcp: {
    command: "doctor mcp",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "mcp" },
      purpose: "定位业务 MCP server 并解释工具语义",
    }],
  },
  model: {
    command: "doctor model",
    needs: [{
      requirement: "required",
      capability: { scope: "plugin", name: "model" },
      purpose: "声明租户目录、模型目录和推理服务",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "tenantDirectory" },
      purpose: "解析可诊断租户",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "modelCatalog" },
      purpose: "发现可用模型",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "inference" },
      purpose: "执行模型验证和推理",
    }],
  },
  metric: {
    command: "doctor metric",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "metric" },
      purpose: "定位指标端点并提供业务指标语义",
    }],
  },
  eval: {
    command: "doctor eval",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "case" },
      purpose: "提供 canonical CaseSet、单次请求触发和协议判定",
    }, {
      requirement: "preferred",
      capability: { scope: "service", name: "traceId" },
      purpose: "把 Case Observation 的业务关联 ID 解析为 trace_id",
      fallback: "只保留 Case Observation，不采集 Trace/Log",
    }, {
      requirement: "preferred",
      capability: { scope: "service", name: "log" },
      purpose: "采集 Case 关联的业务日志",
      fallback: "跳过 Log 证据",
    }, {
      requirement: "preferred",
      capability: { scope: "contribution", name: "inspect" },
      purpose: "采集 Case 关联的业务 Facts/Relations",
      fallback: "跳过业务 Data 证据",
    }],
  },
  perf: {
    command: "doctor perf",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "perf" },
      purpose: "提供 Case 组合与可观测性预设",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "case" },
      purpose: "提供稳定 Case 资产以及单次请求触发和协议判定",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "metric" },
      purpose: "压测窗口内复用 doctor metric 采集指标",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "traceId" },
      purpose: "复用 doctor trace/log 收集代表请求的链路证据",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "log" },
      purpose: "复用 doctor log 收集代表请求的日志证据",
    }],
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
