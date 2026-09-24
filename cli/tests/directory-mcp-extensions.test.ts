import { withSummary } from "@compforge/doctor-plugin";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle } from "../src/collect/evidence";
import { resolveMcpConfiguration, type McpConfigurationInput } from "../src/collect/mcp/configuration";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, DOCTOR_PLUGIN_API_VERSION,
  type ServiceDefinition, type TenantListExtension, type TenantResolveExtension, type UserSearchExtension,
  type McpConfigurationExtension,
} from "@compforge/doctor-plugin";
import { tenantDirectoryExtensions, extensionTenantDirectory } from "../src/plugin/tenant-directory";
import { mcpConfigurationProvider } from "../src/collect/mcp/extensions";
import { validatePluginDefinition } from "../src/plugin/definition";
import { evaluatePluginCapabilities } from "../src/command/plugin-capability";
import { PLUGIN_COMMAND_CAPABILITIES } from "../src/command/plugin-command-capabilities";
import type { ManagedPluginContext } from "../src/plugin/context";

const endpoint = { host: "directory", port: 80 };
const tenant = { id: "t", name: "tenant", displayName: "Tenant" };
const list: TenantListExtension = { id: "list", kind: "tenant.list", access: {}, endpoint, run: withSummary({"title":"租户列表","fields":[{"label":"租户数","path":["length"]}]}, async () => [tenant]) };
const resolve: TenantResolveExtension = { id: "resolve", kind: "tenant.resolve", access: {}, endpoint, run: withSummary({"title":"租户详情","fields":[{"label":"ID","path":["id"]},{"label":"名称","path":["name"]},{"label":"显示名称","path":["displayName"]}]}, async () => tenant) };
const search: UserSearchExtension = {
  id: "search", kind: "user.search", endpoint,
  access: { kubernetes: [{ requirement: "required", purpose: "user lookup", rule: { verb: "get", resource: "configmaps" } }] },
  run: withSummary({"title":"用户查询","fields":[{"label":"总数","path":["total"]},{"label":"本页用户数","path":["users","length"]}]}, async () => ({ users: [], total: 0 })),
};
const service = (extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({
  name: "directory",
  aliases: ["iam"],
  component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } },
  workloads: [],
  extensions
});
const context = (dispose: () => Promise<void>): ManagedPluginContext => ({ signal: new AbortController().signal, dispose } as ManagedPluginContext);

test("directory discovery validates native bindings without calling an extension", () => {
  const run = mock(list.run);
  const services = createServiceCatalog([service([{ ...list, run }, resolve])]);
  const plugin = validatePluginDefinition({ id: "test", version: "1", services }, {
    manifestVersion: 1, pluginApiVersion: DOCTOR_PLUGIN_API_VERSION, id: "test", version: "1",
    requiresDoctor: ">=0.1.0", contentDigest: `sha256:${"0".repeat(64)}`, main: "./plugin.mjs", skills: [],
  });
  expect(tenantDirectoryExtensions(services, "iam").list?.id).toBe("list");
  expect(evaluatePluginCapabilities(plugin, PLUGIN_COMMAND_CAPABILITIES.tenant).runnable).toBe(true);
  expect(run).not.toHaveBeenCalled();
  expect(() => tenantDirectoryExtensions(createServiceCatalog([service([list, { ...list, id: "duplicate" }])]), "directory")).toThrow("ambiguous");
});

test("directory operations isolate access and release contexts on success, failure and malformed output", async () => {
  const searchRun = mock(search.run);
  const providers = tenantDirectoryExtensions(createServiceCatalog([service([list, resolve, { ...search, run: searchRun }])]), "directory");
  const accesses: unknown[] = [];
  const dispose = mock(async () => { });
  const directory = extensionTenantDirectory(providers, async (_service, extension) => {
    accesses.push(extension.access);
    if (extension.kind === "user.search") throw new Error("search access denied");
    return context(dispose);
  });
  expect(accesses).toEqual([]);
  expect(await directory.listActive()).toEqual([tenant]);
  expect(await directory.getByName("tenant")).toEqual(tenant);
  expect(accesses).toEqual([{}, {}]);
  expect(dispose).toHaveBeenCalledTimes(2);
  await expect(directory.searchActiveUsers!({ tenantId: "t", page: 1, pageSize: 10 })).rejects.toThrow("access denied");
  expect(searchRun).not.toHaveBeenCalled();

  const broken = extensionTenantDirectory({ ...providers, list: { ...list, run: async () => { throw new Error("lookup failed"); } } }, async () => context(dispose));
  await expect(broken.listActive()).rejects.toThrow("lookup failed");
  expect(dispose).toHaveBeenCalledTimes(3);
  const invalid = extensionTenantDirectory({ ...providers, list: { ...list, run: withSummary({ title: "Invalid identity", fields: [] }, async () => [{}] as never) } }, async () => context(dispose));
  await expect(invalid.listActive()).rejects.toThrow("invalid identity");
  expect(dispose).toHaveBeenCalledTimes(4);
});

test("user-only provider can serve configured-tenant identity selection", async () => {
  const provider = tenantDirectoryExtensions(createServiceCatalog([service([search])]), "directory");
  const directory = extensionTenantDirectory(provider, async () => context(async () => { }));
  expect(await directory.searchActiveUsers!({ tenantId: "t", page: 1, pageSize: 10 })).toEqual({ users: [], total: 0 });
  await expect(directory.listActive()).rejects.toThrow("missing tenant.list");
});

test("MCP provider selection respects aliases and rejects duplicate implementations", () => {
  const extension: McpConfigurationExtension = {
    id: "config", kind: "mcp.configuration", access: {}, endpoint,
    run: withSummary({"title":"MCP 配置","fields":[{"label":"服务数","path":["servers","length"]}]}, async () => ({ sourceKind: "fixture", servers: [] }))
  };
  const catalog = createServiceCatalog([service([extension])]);
  expect(mcpConfigurationProvider(catalog, "iam").extension).toBe(extension);
  expect(evaluatePluginCapabilities({ id: "test", version: "1", services: catalog }, PLUGIN_COMMAND_CAPABILITIES.mcp).runnable).toBe(true);
  expect(() => mcpConfigurationProvider(catalog, "missing")).toThrow("No mcp.configuration");
  expect(() => mcpConfigurationProvider(createServiceCatalog([service([extension, { ...extension, id: "duplicate" }])]))).toThrow("Ambiguous");
});

test("MCP configuration uses the native operation while gateway access stays with the command", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-mcp-extension-"));
  const bundle = new EvidenceBundle(root, ["mcp-config", "mcp-tools", "http-curl"].map(id => ({ id, title: id, risk: "observe" })));
  const run = mock(async () => ({
    sourceKind: "native", servers: [{
      id: "server", name: "server", tenant: "tenant", displayName: "Server",
      connection: { transport: "sse" as const, path: "/sse" }, tools: [{ name: "tool" }],
    }]
  }));
  const extension: McpConfigurationExtension = { id: "config", kind: "mcp.configuration", access: {}, endpoint, run: withSummary({ title: "Fixture", fields: [] }, run) };
  const capture = { ok: true, command: [], stdout: "", stderr: "", durationMs: 0, exitCode: 0, timedOut: false };
  const forwardGateway = mock(async (): Promise<{ host: string; port: number }> => { throw new Error("gateway unavailable"); });
  const input: McpConfigurationInput = {
    namespace: "test", gatewayService: "gateway", extension, pluginContext: context(async () => { }), bundle,
    selection: { server: "server", tool: "tool", args: "{}" }, timeoutMs: 1000, traceId: "trace", traceparent: "parent",
    podLogs: { listServicePods: async () => ({ podCapture: capture, serviceCapture: capture, byService: { gateway: ["pod"] } }) } as unknown as McpConfigurationInput["podLogs"],
    forwardGateway, writeArtifact: name => name,
  };
  try {
    const result = await resolveMcpConfiguration(input);
    expect(run).toHaveBeenCalledTimes(1);
    expect(forwardGateway).toHaveBeenCalledTimes(1);
    expect(result?.configSourceKind).toBe("native");
    expect(result?.facts.configuration.runtimeToolsError).toBe("gateway unavailable");
    expect(bundle.getSteps().find(step => step.id === "mcp-config")?.status).toBe("ok");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
