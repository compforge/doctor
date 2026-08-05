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
  buildHttpRequest(args: Record<string, unknown>): McpHttpRequestPlan;
}

/** Plugin capability 向 collect 暴露的中性 MCP server 投影，不泄漏 Plugin 原始配置 schema。 */
export interface McpServerDefinition {
  id: string;
  name: string;
  tenant: string;
  displayName: string;
  runtimePath: string;
  tools: readonly McpToolDefinition[];
}

export interface McpConfigStorage {
  type: string;
  url: string;
}

export interface ServiceMcpCapability {
  endpoint: { port: number };
  parseConfigStorage(configMapJson: string): McpConfigStorage;
  listServers(payload: unknown): readonly McpServerDefinition[];
}
