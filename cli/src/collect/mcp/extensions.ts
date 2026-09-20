import {
  MCP_CONFIGURATION_KIND, requireMcpConfigurationExtension,
  type ServiceCatalog,
} from "@compforge/doctor-plugin";

export function mcpConfigurationProvider(catalog: ServiceCatalog, name?: string) {
  const canonical = name === undefined ? undefined : catalog.find(name)?.name;
  const candidates = catalog.extensions(MCP_CONFIGURATION_KIND)
    .filter(item => name === undefined || item.service.name === canonical);
  if (candidates.length !== 1) {
    throw new Error(candidates.length
      ? `Ambiguous mcp.configuration Extension${name ? ` for Service '${name}'` : "; use --gateway-service"}`
      : `No mcp.configuration Extension${name ? ` for Service '${name}'` : ""}`);
  }
  const selected = candidates[0]!;
  return { service: selected.service, extension: requireMcpConfigurationExtension(selected.extension) };
}
