import type { PluginCapabilityContract } from "../command";

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
      capability: { scope: "service", name: "data" },
      purpose: "定位业务数据源并返回约定数据",
    }],
  },
  config: {
    command: "doctor config",
    needs: [{
      requirement: "preferred",
      capability: { scope: "plugin", name: "tenantConfiguration" },
      purpose: "读取 Plugin 声明的租户配置",
      fallback: "只交付 Kubernetes 部署配置",
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
