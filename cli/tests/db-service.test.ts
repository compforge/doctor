import { expect, spyOn, test } from "bun:test";
import { createServiceCatalog, describeService, type PluginDefinition, type PluginDataSource, type ServiceDatabaseDataSource, type ServiceDatabaseTarget } from "@compforge/doctor-plugin";
import { MysqlClient } from "@compforge/harness-toolbox/mysql";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext, resolveKubernetesCommandContext } from "../src/command";
import { resolveStoreProviderConfig } from "../src/collect/store/config";
import { borrowDatabase, resolveDatabaseTarget } from "../src/datasource/database";
import * as databaseAccess from "../src/datasource/database";
import { resolveDbProviders } from "../src/collect/db/providers";
import { resolveDbRequest } from "../src/collect/db/input";
import { openPluginContext } from "../src/plugin/context";
import { validatePluginDefinition } from "../src/plugin/definition";
import type { PluginManifest } from "../src/plugin/manifest";

const manifest = { id: "test", version: "0.0.1" } as PluginManifest;
const target = { host: "mysql.storage", port: 3306, database: "app", user: "reader", password: "hidden", source: { namespace: "storage", path: "/config/db.yaml" } };
const collect = { profileName: "default", kubernetes: { namespace: "app", namespaceSource: "flag" as const, kubeconfigSource: "flag" as const } };
const executor: Executor = {
  run: async args => {
    if (args[0] !== "config") throw new Error("unexpected kubectl access");
    return { ok: true, exitCode: 0, stdout: "test\nhttps://cluster.test", stderr: "", durationMs: 1, timedOut: false, command: args };
  },
  exec: async () => { throw new Error("unexpected Pod exec"); },
};

test("store, db and business consumers share one Service datasource client and root-owned cleanup", async () => {
  let starts = 0, closes = 0;
  class FakeClient extends MysqlClient<ServiceDatabaseTarget> {
    override async initialize() { starts++; }
    override async dispose() { closes++; }
    override get target() { return target; }
  }
  const source: PluginDataSource<MysqlClient<ServiceDatabaseTarget>> = {
    clientKey: "primary",
    createClient: context => {
      expect(context.target.service.name).toBe("logical-api");
      return new FakeClient({ resolve: async () => target, transports: [] }, { signal: context.signal, connectTimeoutMs: 100, queryTimeoutMs: 100 });
    },
  };
  const capability: ServiceDatabaseDataSource = { id: "primary", kind: "db", backend: "mysql", access: {}, source };
  const plugin: PluginDefinition = {
    id: "test", version: "0.0.1", services: createServiceCatalog([{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: "logical-api", aliases: ["api"], workloads: [], capabilities: { dataSources: [capability] },
    }]),
  };
  const command = new CommandContext({}, undefined, { plugin });
  try {
    const resolved = await resolveStoreProviderConfig({ type: "db", service: "api", interactive: false }, plugin,
      collect, executor, command);
    expect(resolved?.config.target).toBeUndefined();
    expect(resolved?.config.service).toBe("logical-api");
    const config = { ...resolved!.config, capability };
    const db = await resolveDatabaseTarget(config, executor, command);
    expect(db.target).toEqual(target);
    const first = await borrowDatabase(command, config, executor, db.target);
    const access = spyOn(databaseAccess, "resolveDatabaseConfig").mockResolvedValue({ config, executor });
    try {
      const providers = await resolveDbProviders(command, await resolveDbRequest({ service: "api", showDatabases: true }));
      expect(providers.service).toBe("logical-api");
      expect(providers.providers).toHaveLength(1);
      expect(providers.failures).toEqual([]);
      expect(access.mock.calls[0]![2]).toBe("logical-api");
    } finally { access.mockRestore(); }
    const business = await openPluginContext(executor, { namespace: "app" }, {
      clients: command.clients, config: command.profile.pluginConfig,
      service: { name: "logical-api", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, workloads: [], capabilities: {} }, command: "doctor data", capability: { access: {} },
      authorization: resolveKubernetesCommandContext(executor, command).access,
    });
    try { expect(await business.clients.get(source)).toBe(first); }
    finally { await business.dispose(); }
    expect(starts).toBe(1);
    expect(closes).toBe(0);
  } finally { await command.disposeClients(); }
  expect(closes).toBe(1);
});

test("Plugin loader validates datasource declarations; describe never constructs clients", () => {
  let called = false;
  const declaration = { id: "primary", kind: "db", backend: "mysql", access: {}, source: {
    clientKey: "primary", createClient: () => { called = true; throw new Error("must not run"); },
  } };
  const plugin = (dataSource: unknown) => ({ id: "test", version: "0.0.1", services: { services: [{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "chat", workloads: [], capabilities: { dataSources: [dataSource] } }] } });
  const loaded = validatePluginDefinition(plugin(declaration), manifest);
  const description = describeService(loaded.services.services[0]!);
  expect(description.details.dataSources).toEqual([{ id: "primary", kind: "db", backend: "mysql", description: undefined }]);
  expect(JSON.stringify(description)).not.toContain("createClient");
  expect(called).toBe(false);
  expect(() => validatePluginDefinition(plugin({ ...declaration, envPrefix: "DB" }), manifest)).toThrow("exactly one");
  expect(() => validatePluginDefinition(plugin({ id: "primary", kind: "db", backend: "mysql" }), manifest)).toThrow("exactly one");
  expect(() => validatePluginDefinition(plugin({ ...declaration, source: { clientKey: "primary" } }), manifest)).toThrow("createClient");
  expect(() => validatePluginDefinition(plugin({ id: "primary", kind: "db", backend: "mysql", envPrefix: "DB" }), manifest)).not.toThrow();
  const old = { id: "test", version: "0.0.1", services: { services: [{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "chat", workloads: [], capabilities: { stores: [declaration] } }] } };
  expect(() => validatePluginDefinition(old, manifest)).toThrow("declare dataSources");
});
