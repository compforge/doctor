import { expect, mock, test } from "bun:test";
import { createServiceCatalog, type MetricConfigurationExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { ClientManager } from "@compforge/harness-common";
import { createHostPluginContext } from "../src/plugin/context";
import { CommandContext } from "../src/command";
import { loadMetricConfigurations, metricConfigurationProviders } from "../src/collect/metric/extensions";
import { resolveMetricConfig } from "../src/collect/metric/config";
import { prepareMetricSource } from "../src/collect/metric/preparation";
import { makeMetricProbes } from "../src/collect/metric/probe";
import type { PluginDefinition } from "@compforge/doctor-plugin";

const declaration = { endpoint: { host: "app", port: 8080, path: "/metrics" }, metricNames: ["requests_total"], charts: [] };
const base: ServiceDefinition = { name: "app", component: { name: "test", repository: { forge: { name: "test" }, path: "test" } }, workloads: [], capabilities: {} };
const extension: MetricConfigurationExtension = { id: "metrics", kind: "metric.configuration", access: {}, run: async () => declaration };

test("Host context reuses root clients without acquiring Kubernetes and respects ownership", async () => {
  const clients = new ClientManager();
  const dispose = mock(async () => {});
  const source = { clientKey: "static", createClient: mock(() => ({ initialize: async () => {}, dispose })) };
  const options = { service: base, capability: extension, clients };
  const first = createHostPluginContext(options);
  const second = createHostPluginContext(options);
  expect(await first.clients.get(source)).toBe(await second.clients.get(source));
  expect(source.createClient).toHaveBeenCalledTimes(1);
  await expect(first.infra.kubernetes.list("pods")).rejects.toThrow();
  const cleanup = mock(() => {});
  first.onDispose(cleanup);
  await first.dispose();
  await first.dispose();
  expect(first.signal.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();
  await second.dispose();
  await clients.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("Host context propagates cancellation and rejects Kubernetes declarations", async () => {
  const controller = new AbortController();
  const context = createHostPluginContext({ service: base, capability: extension, signal: controller.signal });
  controller.abort();
  expect(context.signal.aborted).toBe(true);
  await expect(context.clients.get({ clientKey: "unused", createClient: () => ({ initialize: async () => {}, dispose: async () => {} }) })).rejects.toThrow();
  await context.dispose();
  expect(() => createHostPluginContext({ service: base, capability: { access: { kubernetes: [
    { rule: { verb: "get", resource: "secrets" }, requirement: "required", purpose: "config" },
  ] } } })).toThrow("cannot grant");
});

test("native Metric discovery stays offline and remote preparation needs no Kubernetes", async () => {
  const cleanup = mock(() => {});
  const run = mock(async (context: Parameters<MetricConfigurationExtension["run"]>[0]) => {
    context.onDispose(cleanup);
    return declaration;
  });
  const services = createServiceCatalog([{ ...base, extensions: [{ ...extension, run }] }]);
  expect(metricConfigurationProviders(services)).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
  const command = new CommandContext({});
  try {
    const config = await resolveMetricConfig({ prometheus: "http://prometheus.example" }, services, command, false);
    const executor = { run: mock(async () => { throw new Error("unexpected Kubernetes"); }), exec: mock(async () => { throw new Error("unexpected Kubernetes"); }) };
    const configurations = await loadMetricConfigurations(config!, services, command, executor);
    const source = await prepareMetricSource(config!, { id: "example", version: "0.0.1", services } satisfies PluginDefinition, command, executor, configurations);
    expect(source.sourceKind).toBe("remote");
    expect(makeMetricProbes(config!.services, services, configurations)).toHaveLength(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(executor.run).not.toHaveBeenCalled();
    expect(executor.exec).not.toHaveBeenCalled();
    await source.close();
  } finally { await command.disposeClients(); }
});

test("Metric rejects ambiguous providers and releases context on malformed output", async () => {
  const services = createServiceCatalog([{ ...base, extensions: [extension, { ...extension, id: "duplicate" }] }]);
  expect(() => metricConfigurationProviders(services)).toThrow("ambiguous");
  const cleanup = mock(() => {});
  const invalid = createServiceCatalog([{ ...base, extensions: [{ ...extension, run: async context => {
    context.onDispose(cleanup);
    return { ...declaration, endpoint: { ...declaration.endpoint, port: 0 } };
  } }] }]);
  const command = new CommandContext({});
  try {
    const config = await resolveMetricConfig({ prometheus: "http://prometheus.example" }, invalid, command, false);
    await expect(loadMetricConfigurations(config!, invalid, command)).rejects.toThrow("invalid configuration");
    expect(cleanup).toHaveBeenCalledTimes(1);
  } finally { await command.disposeClients(); }
});

test("Metric configuration access is checked before invoking the provider", async () => {
  const run = mock(async () => declaration);
  const services = createServiceCatalog([{ ...base, extensions: [{ ...extension, run, access: { kubernetes: [
    { rule: { verb: "get", resource: "secrets" }, requirement: "required", purpose: "read metric configuration" },
  ] } }] }]);
  const command = new CommandContext({});
  try {
    const staticServices = createServiceCatalog([{ ...base, extensions: [extension] }]);
    const config = await resolveMetricConfig({ prometheus: "http://prometheus.example" }, staticServices, command, false);
    const executor = {
      run: mock(async (args: string[]) => ({ ok: false, exitCode: 1, stdout: "no", stderr: "forbidden", durationMs: 1, timedOut: false, command: args })),
      exec: mock(async () => { throw new Error("unexpected exec"); }),
    };
    await expect(loadMetricConfigurations(config!, services, command, executor)).rejects.toThrow("权限");
    expect(run).not.toHaveBeenCalled();
    expect(executor.exec).not.toHaveBeenCalled();
  } finally { await command.disposeClients(); }
});
