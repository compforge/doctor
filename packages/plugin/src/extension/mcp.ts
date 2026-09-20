import type { Extension, RegisteredExtension } from "./index";
import type { McpConfigurationProjection } from "../mcp";
import type { ServiceEndpoint } from "../service";
import { requireExtensionEndpoint } from "./endpoint";

export const MCP_CONFIGURATION_KIND = "mcp.configuration";

export interface McpConfigurationExtension extends Extension<{ timeoutMs: number }, McpConfigurationProjection> {
  readonly kind: typeof MCP_CONFIGURATION_KIND;
  readonly endpoint: ServiceEndpoint;
}

export function requireMcpConfigurationExtension(extension: RegisteredExtension): McpConfigurationExtension {
  if (extension.kind !== MCP_CONFIGURATION_KIND) throw new Error(`Expected ${MCP_CONFIGURATION_KIND}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
  return extension as McpConfigurationExtension;
}

/** Validate the projection before target selection or protocol access. */
export function mcpConfigurationOutput(value: unknown): McpConfigurationProjection {
  const projection = value as McpConfigurationProjection | undefined;
  if (!projection || typeof projection.sourceKind !== "string" || !Array.isArray(projection.servers)) {
    throw new Error("mcp.configuration returned an invalid projection");
  }
  for (const server of projection.servers) {
    if (!server || [server.id, server.name, server.tenant, server.displayName].some(item => typeof item !== "string")
      || !server.connection || !["sse", "streamable-http"].includes(server.connection.transport)
      || typeof server.connection.path !== "string" || !Array.isArray(server.tools)) {
      throw new Error("mcp.configuration returned an invalid server");
    }
    for (const tool of server.tools) {
      if (!tool || typeof tool.name !== "string" || !tool.name.trim()
        || (tool.args !== undefined && !Array.isArray(tool.args))
        || (tool.buildHttpRequest !== undefined && typeof tool.buildHttpRequest !== "function")) {
        throw new Error("mcp.configuration returned an invalid tool");
      }
    }
  }
  return projection;
}
