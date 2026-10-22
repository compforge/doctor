import * as serviceNetwork from "@compforge/harness-toolbox/kubernetes/service";
import type { ServicePortForwarder } from "@compforge/harness-toolbox/kubernetes/service-port-forward";
import { prepareStoreMetricCollection } from "../src/collect/metric/store/collector";
import { EmbeddedMetricSource } from "../src/infra/metric";
import { expect, spyOn, test } from "bun:test";
import { createServiceCatalog, describeService, type PluginDefinition, type PluginDataSource, type ServiceDatabaseDataSource, type ServiceDatabaseTarget } from "@compforge/doctor-plugin";
import { MysqlClient, MysqlDatabase } from "@compforge/harness-toolbox/mysql";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext, resolveKubernetesCommandContext } from "../src/command";
import { resolveStoreProviderConfig } from "../src/collect/store/config";
import { borrowDatabase } from "../src/datasource/database";
import * as databaseAccess from "../src/datasource/database";
import { resolveDbProviders } from "../src/collect/db/providers";
import { databaseTargets } from "../src/collect/db/discovery";
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

test("store, db, metric and business consumers share a source without configuration Pods and root-owned cleanup", async () => {
  let starts = 0, closes = 0;
  const database = new MysqlDatabase([], { connectTimeoutMs: 100, queryTimeoutMs: 100 });
  const query = spyOn(database, "query").mockResolvedValue([{ Variable_name: "Queries", Value: "7" }]);
  const network = spyOn(serviceNetwork, "listServiceNetwork").mockResolvedValue({ services: [], pods: [] });
  class FakeClient extends MysqlClient<ServiceDatabaseTarget> {
    override async initialize() { starts++; }
    override async dispose() { closes++; }
    override get target() { return target; }
    override get database() { return database; }
  }
  const source: PluginDataSource<MysqlClient<ServiceDatabaseTarget>> = {
    clientKey: "primary",
    createClient: context => {
      expect(context.target.service.name).toBe("logical-api");
      return new FakeClient({ resolve: async () => target, transports: [] }, { signal: context.signal, connectTimeoutMs: 100, queryTimeoutMs: 100 });
    },
  };
  const capability: ServiceDatabaseDataSource = { id: "primary", description: "Canonical records", kind: "db", backend: "mysql", access: {}, source };
  const plugin: PluginDefinition = {
    id: "test", version: "0.0.1", services: createServiceCatalog([{
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      name: "logical-api",
      aliases: ["api"],
      workloads: [],
      dataSources: [capability, { ...capability, id: "history", description: "Historical records on the same connection" }]
    }]),
  };
  const command = new CommandContext({}, undefined, { plugin });
  try {
    const resolved = await resolveStoreProviderConfig({ type: "db", service: "api", store: "primary", interactive: false }, plugin,
      collect, executor, command);
    expect(resolved?.config.target).toBeUndefined();
    expect(resolved?.config.service).toBe("logical-api");
    const config = { ...resolved!.config, capability };
    const first = await borrowDatabase(command, config, executor);
    expect(first.target).toEqual(target);
    const access = spyOn(databaseAccess, "resolveDatabaseConfig").mockResolvedValue({ config, executor });
    try {
      const providers = await resolveDbProviders(command, await resolveDbRequest({ service: "api", showDatabases: true }));
      expect(providers.service).toBe("logical-api");
      expect(providers.providers).toHaveLength(2);
      expect(databaseTargets(providers.providers)).toHaveLength(1);
      expect(providers.providers.flatMap(provider => provider.dataSources)).toEqual([
        { id: "primary", description: "Canonical records" },
        { id: "history", description: "Historical records on the same connection" },
      ]);
      expect(providers.failures).toEqual([]);
      expect(access.mock.calls[0]![2]).toBe("logical-api");
    } finally { access.mockRestore(); }
    const metrics = await prepareStoreMetricCollection({
      plugin, commandContext: command, collect, services: ["logical-api"], executor,
      forwarder: { forwardServiceTargets: async () => [] } as unknown as ServicePortForwarder,
      namespace: "app", intervalMs: 1000,
    });
    const metricSource = new EmbeddedMetricSource({ retentionMs: 60_000, sampleIntervalMs: 1000 });
    const ingest = spyOn(metricSource, "ingest");
    try {
      expect(metrics.directCount).toBe(1);
      expect(await metrics.sample(metricSource)).toEqual([]);
      expect(query).toHaveBeenCalledWith(target, "SHOW GLOBAL STATUS", []);
      expect(ingest.mock.calls[0]?.[0]).toContain("mysql_global_status_queries 7");
    } finally { ingest.mockRestore(); await metrics.close(); }
    const business = await openPluginContext(executor, { namespace: "app" }, {
      clients: command.clients, config: command.profile.pluginConfig,
      service: {
        name: "logical-api",
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        workloads: []
      }, command: "doctor data", capability: { access: {} },
      authorization: resolveKubernetesCommandContext(executor, command).access,
    });
    try { expect(await business.clients.get(source)).toBe(first); }
    finally { await business.dispose(); }
    expect(starts).toBe(1);
    expect(closes).toBe(0);
  } finally { network.mockRestore(); query.mockRestore(); await command.disposeClients(); await database.close(); }
  expect(closes).toBe(1);
});

test("Plugin loader validates datasource declarations; describe never constructs clients", () => {
  let called = false;
  const declaration = {
    id: "primary", kind: "db", backend: "mysql", access: {}, source: {
      clientKey: "primary", createClient: () => { called = true; throw new Error("must not run"); },
    }
  };
  const plugin = (dataSource: unknown) => ({
    id: "test", version: "0.0.1", services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "chat",
        workloads: [],
        dataSources: [dataSource]
      }]
    }
  });
  const loaded = validatePluginDefinition(plugin(declaration), manifest);
  const description = describeService(loaded.services.services[0]!);
  expect(description.details.dataSources).toEqual([{ id: "primary", kind: "db", backend: "mysql", description: undefined }]);
  expect(JSON.stringify(description)).not.toContain("createClient");
  expect(called).toBe(false);
  expect(() => validatePluginDefinition(plugin({ ...declaration, envPrefix: "DB" }), manifest)).toThrow("source");
  expect(() => validatePluginDefinition(plugin({ id: "primary", kind: "db", backend: "mysql" }), manifest)).toThrow("source");
  expect(() => validatePluginDefinition(plugin({ ...declaration, source: { clientKey: "primary" } }), manifest)).toThrow("createClient");
  expect(() => validatePluginDefinition(plugin({ id: "primary", kind: "db", backend: "mysql", envPrefix: "DB" }), manifest)).toThrow("envPrefix is unsupported");
  const redis = { ...declaration, kind: "redis", backend: "redis" };
  expect(() => validatePluginDefinition(plugin(redis), manifest)).not.toThrow();
  expect(() => validatePluginDefinition(plugin({ ...redis, source: undefined }), manifest)).toThrow("source is required");
  expect(() => validatePluginDefinition(plugin({ ...redis, environment: { address: "REDIS_HOST" } }), manifest)).toThrow("environment is unsupported");
  const old = { id: "test", version: "0.0.1", services: { services: [{ component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, name: "chat", workloads: [], capabilities: { stores: [declaration] } }] } };
  expect(() => validatePluginDefinition(old, manifest)).toThrow("unsupported Service API");
});

test("different factories remain logical sources with separate clients for the same runtime database", async () => {
  let starts = 0;
  let closes = 0;
  class FakeClient extends MysqlClient<ServiceDatabaseTarget> {
    override async initialize() { starts++; }
    override async dispose() { closes++; }
    override get target() { return target; }
  }
  const sources: ServiceDatabaseDataSource[] = ["primary", "secondary"].map(id => ({
    id, kind: "db", backend: "mysql", access: {}, source: {
      clientKey: `${id}-config`, createClient: context => new FakeClient({ resolve: async () => target, transports: [] },
        { signal: context.signal, connectTimeoutMs: 100, queryTimeoutMs: 100 }),
    },
  }));
  const command = new CommandContext({}, undefined, { plugin: {
    id: "test", version: "0.0.1", services: createServiceCatalog([{
      name: "api", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: [], dataSources: sources,
    }]),
  } });
  const access = spyOn(databaseAccess, "resolveDatabaseConfig").mockImplementation(async (_context, _input, service, capability) => ({
    config: { collect, service, capability }, executor,
  }));
  try {
    const resolved = await resolveDbProviders(command, await resolveDbRequest({ service: "api", showDatabases: true }));
    expect(resolved.failures).toEqual([]);
    expect(resolved.providers.map(provider => provider.id)).toEqual(["primary", "secondary"]);
    expect(databaseTargets(resolved.providers)).toHaveLength(1);
    expect(starts).toBe(2);
    expect(closes).toBe(0);
  } finally { access.mockRestore(); await command.disposeClients(); }
  expect(closes).toBe(2);
});

test("explicit datasource selection filters before resolution and unknown sources never access the environment", async () => {
  const sources: ServiceDatabaseDataSource[] = ["primary", "secondary"].map(id => ({ id, kind: "db", backend: "mysql", source: { clientKey: id, createClient: () => { throw new Error("Unexpected database access"); } } }));
  const command = new CommandContext({}, undefined, { plugin: {
    id: "test", version: "0.0.1", services: createServiceCatalog([{
      name: "api", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: [], dataSources: sources,
    }]),
  } });
  const seen: string[] = [];
  const access = spyOn(databaseAccess, "resolveDatabaseConfig").mockImplementation(async (_context, _input, _service, capability) => {
    seen.push(capability.id);
    throw new Error("fixture access failure");
  });
  try {
    await expect(resolveDbProviders(command, await resolveDbRequest({ service: "api", dataSource: "missing", showDatabases: true })))
      .rejects.toThrow("未声明 DB DataSource");
    expect(seen).toEqual([]);
    const resolved = await resolveDbProviders(command, await resolveDbRequest({ service: "api", dataSource: "secondary", showDatabases: true }));
    expect(seen).toEqual(["secondary"]);
    expect(resolved.failures.map(failure => failure.id)).toEqual(["secondary"]);
  } finally { access.mockRestore(); await command.disposeClients(); }
});
