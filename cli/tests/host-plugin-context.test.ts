import { expect, mock, test } from "bun:test";
import { ClientManager } from "@compforge/harness-common";
import type { ServiceDefinition } from "@compforge/doctor-plugin";
import { createHostPluginContext } from "../src/plugin/context";

const base: ServiceDefinition = {
  name: "app",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: [],
};
const capability = { access: {} };

test("Host context reuses root clients without acquiring Kubernetes and respects ownership", async () => {
  const clients = new ClientManager();
  const dispose = mock(async () => { });
  const source = { clientKey: "static", createClient: mock(() => ({ initialize: async () => { }, dispose })) };
  const options = { service: base, capability, clients };
  const first = createHostPluginContext(options);
  const second = createHostPluginContext(options);
  expect(await first.clients.get(source)).toBe(await second.clients.get(source));
  expect(source.createClient).toHaveBeenCalledTimes(1);
  await expect(first.infra.kubernetes.list({ apiVersion: "v1", resource: "pods" })).rejects.toThrow();
  const cleanup = mock(() => { });
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
  const context = createHostPluginContext({ service: base, capability, signal: controller.signal });
  controller.abort();
  expect(context.signal.aborted).toBe(true);
  await expect(context.clients.get({ clientKey: "unused", createClient: () => ({ initialize: async () => { }, dispose: async () => { } }) })).rejects.toThrow();
  await context.dispose();
  expect(() => createHostPluginContext({
    service: base, capability: {
      access: {
        kubernetes: [
          { rule: { verb: "get", resource: "secrets" }, requirement: "required", purpose: "config" },
        ]
      }
    }
  })).toThrow("cannot grant");
});

