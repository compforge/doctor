import type { PluginContext } from "./context";

export interface McpArgumentDefinition {
  name: string;
  position: string;
  required: boolean;
  type: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: { type?: string; enum?: unknown[] };
}

export interface McpHttpRequestPlan {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  warnings: string[];
  unsupported: string[];
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  args?: readonly McpArgumentDefinition[];
  buildHttpRequest?(args: Record<string, unknown>): McpHttpRequestPlan;
}

/** Plugin capability 向 collect 暴露的中性 MCP server 投影，不泄漏 Plugin 原始配置 schema。 */
export interface McpServerDefinition {
  id: string;
  name: string;
  /** mcp-gateway 的路由隔离维度，是 server 目标身份的一部分。 */
  tenant: string;
  displayName: string;
  connection: {
    transport: "sse" | "streamable-http";
    path: string;
  };
  tools: readonly McpToolDefinition[];
}

/** Plugin 从私有配置来源投影出的本轮 MCP 配置，不暴露原始业务 schema。 */
export interface McpConfigurationProjection {
  sourceKind: string;
  servers: readonly McpServerDefinition[];
}

export interface ServiceMcpCapability {
  endpoint: { port: number };
  loadConfiguration(
    context: PluginContext,
    input: { timeoutMs: number },
  ): Promise<McpConfigurationProjection>;
}
