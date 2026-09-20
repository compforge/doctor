import { directoryExtensions, mcpExtension } from "./extension-fixture";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, requireTenantListExtension, requireMcpConfigurationExtension,
  tenantListOutput, tenantResolveOutput, userSearchOutput, mcpConfigurationOutput,
  type ServiceDefinition, type TenantListExtension, type McpConfigurationExtension,
} from "../src";

const base: ServiceDefinition = {
  name: "directory",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};
const endpoint = { host: "directory", port: 8080 };
const list: TenantListExtension = { id: "tenants", kind: "tenant.list", access: {}, endpoint, run: async () => [] };
const mcp: McpConfigurationExtension = {
  id: "configuration", kind: "mcp.configuration", access: {}, endpoint,
  run: async () => ({ sourceKind: "fixture", servers: [] }),
};

test("legacy directory and MCP discovery does not create clients or read configuration", () => {
  const create = mock(() => ({ listActive: async () => [], getByName: async (name: string) => ({ id: name, name, displayName: name }) }));
  const loadConfiguration = mock(mcp.run);
  const service = {
    ...base,
    extensions: [...directoryExtensions({ access: {}, endpoint, create }),
    mcpExtension({ access: {}, endpoint, loadConfiguration })]
  };
  const catalog = createServiceCatalog([service]);
  for (const kind of ["tenant.list", "tenant.resolve", "mcp.configuration"]) {
    expect(catalog.extensions(kind)).toHaveLength(1);
  }
  expect(catalog.extensions("user.search")).toHaveLength(0);
  expect(create).not.toHaveBeenCalled();
  expect(loadConfiguration).not.toHaveBeenCalled();
  expect(() => createServiceCatalog([{ ...service, extensions: [list, list] }])).toThrow("duplicate");
  expect(() => createServiceCatalog([{ ...service, extensions: [mcp, mcp] }])).toThrow("duplicate");
});

test("directory contracts reject malformed endpoints, identities and pagination", () => {
  expect(() => requireTenantListExtension({ ...list, endpoint: { host: "", port: 80 } } as TenantListExtension)).toThrow("endpoint");
  expect(() => tenantListOutput({})).toThrow("array");
  expect(() => tenantResolveOutput({ id: "t" })).toThrow("identity");
  expect(() => userSearchOutput({ users: [], total: -1 })).toThrow("page");
  expect(() => userSearchOutput({ users: [{ id: "u", name: "user", displayName: "User" }], total: 0 })).toThrow("page");
  expect(tenantListOutput([])).toEqual([]);
  expect(userSearchOutput({ users: [], total: 0 })).toEqual({ users: [], total: 0 });
});

test("MCP contract validates projected targets and preserves callable tool mappings", () => {
  expect(() => requireMcpConfigurationExtension({ ...mcp, endpoint: { host: "host", port: 70000 } } as McpConfigurationExtension)).toThrow("endpoint");
  expect(() => mcpConfigurationOutput({ sourceKind: "test", servers: [null] })).toThrow("server");
  const buildHttpRequest = () => ({ method: "GET", url: "https://test", headers: {}, warnings: [], unsupported: [] });
  const projection = {
    sourceKind: "fixture", servers: [{
      id: "s", name: "server", tenant: "t", displayName: "Server",
      connection: { transport: "sse", path: "/sse" }, tools: [{ name: "tool", buildHttpRequest }]
    }]
  };
  expect(mcpConfigurationOutput(projection).servers[0]?.tools[0]?.buildHttpRequest).toBe(buildHttpRequest);
});
