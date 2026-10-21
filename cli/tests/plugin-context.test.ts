import { kubernetesClientSource, resourceReader, snapshotResourceReader } from "../src/infra/k8s/resources";
import type { FileReadResult } from "@compforge/harness-common";
import { afterEach, expect, spyOn, test } from "bun:test";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubernetesAccessContext } from "../src/infra/k8s/access";
import { createPluginContext, openPluginContext, preflightPluginAccess } from "../src/plugin/context";
import type {
  ExecResult,
  Executor,
  RunOptions,
} from "@compforge/harness-toolbox/kubernetes/executor";

function result(command: string[], stdout = "", ok = true): ExecResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: ok ? "" : "forbidden",
    durationMs: 1,
    timedOut: false,
    command,
  };
}

const apiCleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of apiCleanups.splice(0)) await close(); });

async function kubernetesApi() {
  const paths: string[] = [];
  let connections = 0;
  let respond: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => { response.end('{"kind":"Service"}'); };
  const server = createServer((request, response) => { paths.push(request.url!); respond(request, response); });
  server.on("connection", () => { connections++; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected test API port");
  const directory = mkdtempSync(join(tmpdir(), "doctor-kubernetes-api-"));
  const kubeconfig = join(directory, "config.json");
  const endpoint = `http://127.0.0.1:${address.port}`;
  writeFileSync(kubeconfig, JSON.stringify({ apiVersion: "v1", kind: "Config", "current-context": "test-context",
    clusters: [{ name: "test", cluster: { server: endpoint } }],
    contexts: [{ name: "test-context", context: { cluster: "test", user: "test" } }], users: [{ name: "test", user: {} }] }));
  apiCleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { kubeconfig, endpoint, paths, get connections() { return connections; },
    set respond(value: typeof respond) { respond = value; } };
}

test("Plugin Kubernetes access is target-scoped and Core-owned", async () => {
  const api = await kubernetesApi();
  const calls: Array<{ kind: "run" | "exec"; command: string[]; options?: RunOptions }> = [];
  const executor: Executor = {
    run: async (command, options) => {
      calls.push({ kind: "run", command, options });
      return result(command, '{"kind":"Service"}');
    },
    exec: async (target, command, options) => {
      calls.push({ kind: "exec", command: [target.pod, ...command], options });
      return result(command, "A=B\n");
    },
  };
  const service = {
    name: "sample-api",
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    workloads: []
  };
  const context = createPluginContext(executor, {
    kubeconfig: api.kubeconfig,
    context: "test-context",
    namespace: "default",
  }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" },
    config: { region: "sample" },
    service,
    capability: {
      access: {
        kubernetes: [{
          rule: { verb: "get", resource: "services" },
          requirement: "required",
          purpose: "读取 Service",
        }, {
          rule: { verb: "create", resource: "pods/exec" },
          requirement: "required",
          purpose: "读取运行态环境",
        }],
      },
    },
  });

  expect(await context.infra.kubernetes.get<{ kind: string }>({ apiVersion: "v1", resource: "services", name: "sample-api" }))
    .toEqual({ kind: "Service" });
  expect(await context.infra.kubernetes.exec({ pod: "sample-api-0" }, ["env"]))
    .toBe("A=B\n");
  expect(context.target).toMatchObject({
    env: "cluster-test",
    namespace: "default",
    service: { ...service, environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" } },
  });
  expect(context.config).toEqual({ region: "sample" });
  expect(context).not.toHaveProperty("kubeconfig");
  expect(context).not.toHaveProperty("kubeContext");
  expect(calls.map(({ kind, command }) => ({ kind, command }))).toEqual([{
    kind: "exec",
    command: ["sample-api-0", "env"],
  }]);
  expect(api.paths).toEqual(["/api/v1/namespaces/default/services/sample-api"]);
  expect(calls.every(({ options }) => options?.timeoutMs === 20_000)).toBe(true);
  expect(calls.every(({ options }) => options?.signal?.aborted === false)).toBe(true);

  await context.dispose();
  expect(context.signal.aborted).toBe(true);
});

test("Plugin Kubernetes access preserves native API failure kinds without running kubectl queries", async () => {
  const api = await kubernetesApi();
  const executor: Executor = {
    run: async () => { throw new Error("Resource read must use the native transport"); },
    exec: async (_target, command) => result(command, "", false),
  };
  const context = createPluginContext(executor, { namespace: "default", kubeconfig: api.kubeconfig }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: api.endpoint },
    service: { name: "sample-api", component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, workloads: [] },
    capability: { access: { kubernetes: [{ rule: { verb: "get", resource: "secrets" }, requirement: "required", purpose: "test" }] } },
  });
  try {
    for (const [status, kind] of [[404, "resource_not_found"], [403, "permission_denied"], [401, "authentication_failed"], [408, "timeout"]]) {
      api.respond = (_request, response) => { response.writeHead(status as number); response.end("private credentials"); };
      const error = await context.infra.kubernetes.get({ apiVersion: "v1", resource: "secrets", name: "sample" }).catch(error => error);
      expect(error).toMatchObject({ kind, code: status });
      expect((error as Error).message).not.toContain("private credentials");
    }
  } finally { await context.dispose(); }
});

test("Plugin access preflight only includes the selected Service capability", async () => {
  const calls: string[][] = [];
  const executor: Executor = {
    run: async (command) => {
      calls.push(command);
      return result(command, command[0] === "auth" ? "yes\n" : '{"kind":"Service"}');
    },
    exec: async (_target, command) => result(command),
  };
  const context = await openPluginContext(executor, { namespace: "default" }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" },
    service: {
      name: "selected-api",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    },
    command: "doctor data",
    capability: {
      access: {
        kubernetes: [{
          rule: { verb: "get", resource: "services" },
          requirement: "required",
          purpose: "解析所选 Service",
        }],
      },
    },
    authorization: new KubernetesAccessContext(executor),
  });

  expect(calls).toEqual([["auth", "can-i", "get", "services"]]);
  await context.dispose();
});

test("Core expands port-forward into its Kubernetes transport requirements", async () => {
  const calls: string[][] = [];
  const executor: Executor = {
    run: async (command) => {
      calls.push(command);
      return result(command, "yes\n");
    },
    exec: async (_target, command) => result(command),
  };
  const context = await openPluginContext(executor, { namespace: "default" }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" },
    service: {
      name: "selected-api",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    },
    command: "doctor model",
    capability: {
      access: {
        kubernetes: [{
          rule: { verb: "create", resource: "pods/portforward" },
          requirement: "required",
          purpose: "访问 Service endpoint",
        }],
      },
    },
    authorization: new KubernetesAccessContext(executor),
  });

  expect(calls).toEqual([
    ["auth", "can-i", "create", "pods/portforward"],
    ["auth", "can-i", "list", "services"],
    ["auth", "can-i", "list", "pods"],
  ]);
  await context.dispose();
});

test("Plugin Kubernetes helper rejects undeclared operations", async () => {
  const executor: Executor = {
    run: async (command) => result(command, '{"kind":"Secret"}'),
    exec: async (_target, command) => result(command),
  };
  const context = createPluginContext(executor, { namespace: "default" }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" },
    service: {
      name: "selected-api",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    },
    capability: { access: {} },
  });

  await expect(context.infra.kubernetes.get({ apiVersion: "v1", resource: "secrets", name: "sample" }))
    .rejects.toThrow("未声明 Kubernetes access: get secrets");
  await expect(context.infra.kubernetes.inNamespace("other").get({ apiVersion: "v1", resource: "secrets", name: "sample" }))
    .rejects.toThrow("未声明 Kubernetes access: get secrets");
  await context.dispose();
});

test("Plugin Kubernetes access enforces the Core output limit", async () => {
  const api = await kubernetesApi();
  api.respond = (_request, response) => response.end("x".repeat(4 * 1024 * 1024 + 1));
  const executor: Executor = {
    run: async (command) => result(command, "x".repeat(4 * 1024 * 1024 + 1)),
    exec: async (_target, command) => result(command),
  };
  const { ClientManager, clientKey } = await import("@compforge/harness-common");
  const { KubernetesClient } = await import("@compforge/harness-toolbox/kubernetes/client");
  const clients = new ClientManager();
  const kube = { namespace: "default", kubeconfig: api.kubeconfig, context: "test-context" };
  await clients.get({ clientKey: clientKey("kubernetes", kube),
    createClient: (_clients, signal) => new KubernetesClient(kube, signal, executor) });
  const context = createPluginContext(executor, kube, {
    clients,
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" },
    service: {
      name: "sample-api",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    },
    capability: {
      access: {
        kubernetes: [{
          rule: { verb: "get", resource: "configmaps" },
          requirement: "required",
          purpose: "test",
        }],
      },
    },
  });

  await expect(context.infra.kubernetes.get({ apiVersion: "v1", resource: "configmaps", name: "sample" }))
    .rejects.toMatchObject({ kind: "limit_exceeded" });
  await context.dispose();
  await clients.dispose();
});

test("Plugin exec forwards stdin under access checks and caps timeout without exposing payload in errors", async () => {
  const calls: RunOptions[] = [];
  const executor: Executor = {
    run: async command => result(command),
    exec: async (_target, command, options) => {
      calls.push(options!);
      return result(command, "", false);
    },
  };
  const context = createPluginContext(executor, { namespace: "default" }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" }, service: {
      name: "sample",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    },
    capability: { access: { kubernetes: [{ requirement: "required", rule: { verb: "create", resource: "pods/exec" }, purpose: "query" }] } },
  });
  await expect(context.infra.kubernetes.exec({ pod: "sample-0" }, ["python", "-c", "private-script"], { stdin: "secret", timeoutMs: 60_000 }))
    .rejects.toThrow("kubectl -n default exec sample-0 失败：forbidden");
  expect(calls[0]?.stdin).toBe("secret");
  expect(calls[0]?.timeoutMs).toBe(20_000);
  expect(calls[0]?.signal?.aborted).toBe(false);
  await context.dispose();
  const denied = createPluginContext(executor, { namespace: "default" }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" }, service: {
      name: "sample",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    }, capability: { access: {} },
  });
  await expect(denied.infra.kubernetes.exec({ pod: "sample-0" }, ["python"], { stdin: "secret" })).rejects.toThrow("未声明");
  expect(calls).toHaveLength(1);
  await denied.dispose();
});

// This exercises the actual host adapter, including distinct capability-call lifetimes.
test("siblings share resources after the first PluginContext is disposed, but never share permissions or targets", async () => {
  const api = await kubernetesApi();
  const { CommandContext, defineCommand, CommandStatus } = await import("../src/command");
  const root = new CommandContext({});
  let discoveries = 0;
  let closed = 0;
  const executor: Executor = {
    run: async (command, options) => {
      options?.signal?.throwIfAborted();
      return result(command, command[0] === "auth" ? "yes" : '{"kind":"Service"}');
    },
    exec: async (_target, command) => result(command),
  };
  const options = {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" }, service: {
      name: "api",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    },
    capability: { access: { kubernetes: [{ rule: { verb: "get", resource: "services" }, requirement: "required", purpose: "discover" }] } },
  } as const;
  const query = defineCommand<import("../src/command").CommandInput & { id: string }, string>({
    name: "sample", prepare: async (_context, input) => input, run: async (_root, input) => {
      const context = createPluginContext(executor, { namespace: "test", kubeconfig: api.kubeconfig }, options);
      const client = await context.clients.get({
        clientKey: "db", createClient: resource => ({
          initialize: async () => { discoveries++; },
          dispose: async () => { closed++; },
          query: async (id: string) => {
            await resource.infra.kubernetes.get({ apiVersion: "v1", resource: "services", name: "api" });
            return id;
          },
        })
      });
      await context.dispose();
      expect(context.signal.aborted).toBe(true);
      return { status: CommandStatus.Ok, artifacts: [], output: await client.query(input.id) };
    }
  });
  const first = await query.run(root, { id: "summary" });
  const siblings = await Promise.all([query.run(root, { id: "a" }), query.run(root, { id: "b" })]);
  expect([first, ...siblings].map(r => r.output)).toEqual(["summary", "a", "b"]);
  expect(discoveries).toBe(1);
  expect(closed).toBe(0);

  const isolation = defineCommand({
    name: "isolation", prepare: async (_context, input) => input, run: async () => {
      const variants = [
        { kube: { namespace: "other" }, options },
        { kube: { namespace: "test" }, options: { ...options, config: { tenant: "other" } } },
        { kube: { namespace: "test" }, options: { ...options, databaseIdentity: { user: "other", password: "secret" } } },
        {
          kube: { namespace: "test", context: "other-cluster" }, options: {
            ...options,
            environment: { ...options.environment, name: "other-cluster", context: "other-cluster" }
          }
        },
        { kube: { namespace: "test" }, options: { ...options, capability: { access: {} } } },
      ];
      for (const variant of variants) {
        const ctx = createPluginContext(executor, variant.kube, variant.options);
        const distinct = await ctx.clients.get({ clientKey: "db", createClient: resource => ({ resource, initialize: async () => { }, dispose: async () => { } }) });
        expect(distinct).toHaveProperty("resource");
        if (!("kubernetes" in variant.options.capability.access)) {
          await expect(distinct.resource.infra.kubernetes.get({ apiVersion: "v1", resource: "services", name: "api" })).rejects.toThrow("未声明");
        }
      }
      return { status: CommandStatus.Ok, artifacts: [], output: undefined };
    }
  });
  expect((await isolation.run(root, {})).status).toBe(CommandStatus.Ok);
  await root.disposeClients();
  expect(closed).toBe(1);
});

test("repeated successful access prints once, and reuse never bypasses a caller's authorization", async () => {
  const { enforceKubernetesAccess } = await import("../src/terminal/kubernetes-access");

  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  let checks = 0;
  const executor: Executor = {
    run: async command => { checks++; return result(command, "yes"); },
    exec: async (_target, command) => result(command),
  };
  const access = new KubernetesAccessContext(executor);
  const need = { rule: { verb: "get", resource: "services" }, requirement: "required", purpose: "test" } as const;
  const contract = { command: "overview", namespace: "test", needs: [need] };
  try {
    await Promise.all([enforceKubernetesAccess(access, contract), enforceKubernetesAccess(access, contract)]);
    expect(checks).toBe(1);
    expect(output).toHaveBeenCalledTimes(1);
    const denied = new KubernetesAccessContext({ ...executor, run: async command => result(command, "no", false) });
    await expect(openPluginContext(executor, { namespace: "test" }, {
      environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" }, service: {
        name: "api",
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        workloads: []
      }, command: "sample", authorization: denied,
      capability: { access: { kubernetes: [need] } },
    })).rejects.toThrow("缺少必须");
  } finally { output.mockRestore(); }
});


test("Pod relay is shared across Services, scoped by namespace, and permission checked for every borrower", async () => {
  const { ClientManager } = await import("@compforge/harness-common");
  const { PodRelayTransport } = await import("@compforge/harness-toolbox/transport");
  const root = new ClientManager();
  const instances: object[] = [];
  const connect = spyOn(PodRelayTransport.prototype, "connect").mockImplementation(function (this: object, endpoint) {
    instances.push(this);
    return Promise.resolve({ ...endpoint, host: "127.0.0.1" });
  });
  const close = spyOn(PodRelayTransport.prototype, "dispose");
  const executor: Executor = {
    run: async () => { throw new Error("Unexpected Kubernetes discovery"); },
    exec: async () => { throw new Error("Unexpected Kubernetes exec"); },
  };
  const needs = [
    { verb: "list", resource: "pods" },
    { verb: "create", resource: "pods/exec" },
    { verb: "create", resource: "pods/portforward" },
  ].map(rule => ({ rule, requirement: "required" as const, purpose: "relay" }));
  const contexts: ReturnType<typeof createPluginContext>[] = [];
  const context = (name: string, namespace = "test", rules = needs) => {
    const value = createPluginContext(executor, { namespace }, {
      clients: root,
      environment: { name: "test", kind: "kubernetes", context: "test", server: "https://test/" },
      service: { name, workloads: [], component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } } },
      capability: { access: { kubernetes: rules } },
    });
    contexts.push(value);
    return value;
  };
  const endpoint = { host: "global-db.example", port: 3306 };
  try {
    const first = context("first");
    const second = context("second");
    await Promise.all([first.infra.kubernetes.podRelay(endpoint), second.infra.kubernetes.podRelay(endpoint)]);
    expect(instances).toHaveLength(2);
    expect(instances[0]).toBe(instances[1]);
    await first.dispose();
    expect(close).not.toHaveBeenCalled();
    await second.infra.kubernetes.podRelay(endpoint);
    expect(instances[2]).toBe(instances[0]);
    await context("third", "other").infra.kubernetes.podRelay(endpoint);
    expect(instances[3]).not.toBe(instances[0]);
    for (const missing of needs) {
      await expect(context("denied", "test", needs.filter(need => need !== missing))
        .infra.kubernetes.podRelay(endpoint)).rejects.toThrow("未声明 Kubernetes access");
    }
    await expect(second.infra.kubernetes.inNamespace("other").podRelay(endpoint)).rejects.toThrow("未声明");
    expect(instances).toHaveLength(4);
    await root.dispose();
    expect(close).toHaveBeenCalledTimes(2);
    await expect(second.infra.kubernetes.podRelay(endpoint)).rejects.toThrow();
  } finally {
    await Promise.all(contexts.map(value => value.dispose()));
    await root.dispose();
    connect.mockRestore();
    close.mockRestore();
  }
});

/** @case id=file_source_pool,desc=Separate file sources borrow one native resource pool until root disposal */
test("file source resolution reuses Inspect observations and checks each borrower before sharing native connections", async () => {
  const { ClientManager } = await import("@compforge/harness-common");
  const { fileDataSource } = await import("@compforge/doctor-plugin");
  const api = await kubernetesApi();
  const root = new ClientManager();
  let reads = 0;
  api.respond = (request, response) => response.end(JSON.stringify(request.url?.includes("/services/")
    ? { spec: { selector: { app: "api" } } }
    : { items: [{ metadata: { name: "api-0" } }], metadata: { resourceVersion: "42" } }));
  const executor: Executor = {
    run: async () => { throw new Error("File target discovery must not spawn kubectl"); },
    exec: async (_target, command, options) => {
      reads++;
      options?.onStdoutBytes?.(Buffer.from(`0 ${Buffer.concat([Buffer.from("endpoint: sandbox-server"), Buffer.from([0]), Buffer.from("000")]).toString("base64")}\n`));
      return result(command);
    },
  };
  const needs = [
    { verb: "get", resource: "services" }, { verb: "list", resource: "pods", allNamespaces: true },
    { verb: "create", resource: "pods/exec" },
  ].map(rule => ({ rule, requirement: "required" as const, purpose: "read file configuration" }));
  const access = { kubernetes: needs };
  const observed = snapshotResourceReader(resourceReader(await root.get(kubernetesClientSource({
    namespace: "default", kubeconfig: api.kubeconfig, context: "test-context",
  }, executor)), new AbortController().signal));
  await observed({ apiVersion: "v1", resource: "services", namespace: "default", name: "api" });
  await observed({ apiVersion: "v1", resource: "pods", namespace: "default", labelSelector: "app=api" });
  const open = (declared = access) => createPluginContext(executor, { namespace: "default", kubeconfig: api.kubeconfig }, {
    clients: root, resources: observed,
    environment: { name: "test", kind: "kubernetes", context: "test-context", server: api.endpoint },
    service: { name: "api", workloads: [], component: { name: "fixture", repository: { forge: { name: "test" }, path: "api" } } },
    capability: { access: declared },
  });
  const source = (path: string) => fileDataSource([path], { workload: "main", access, resolve: async context => {
    const service = await context.infra.kubernetes.get<{ spec: { selector: { app: string } } }>({ apiVersion: "v1", resource: "services", name: "api" });
    const pods = await context.infra.kubernetes.list<{ metadata: { name: string } }>({
      apiVersion: "v1", resource: "pods", labelSelector: `app=${service.spec.selector.app}`,
    });
    expect(pods.metadata).toEqual({ resourceVersion: "42" });
    return { namespace: "default", pod: pods.items[0]!.metadata.name, container: "main" };
  } });
  const first = open();
  const second = open();
  const denied = open({ kubernetes: [] });
  try {
    const main = await first.clients.get(source("/config.yaml"));
    await first.dispose();
    const secret = await second.clients.get(source("/secret/config.yaml"));
    await second.infra.kubernetes.inNamespace("other").list({ apiVersion: "v1", resource: "pods" });
    await expect(second.infra.kubernetes.inNamespace("other").get({ apiVersion: "v1", resource: "services", name: "api" })).rejects.toThrow("未声明");
    await expect(second.infra.kubernetes.list({ apiVersion: "example.io/v1", resource: "pods" })).rejects.toThrow("未声明");
    await expect(denied.infra.kubernetes.get({ apiVersion: "v1", resource: "services", name: "api" })).rejects.toThrow("未声明");
    expect(api.paths).toHaveLength(3);
    expect(api.paths[2]).toBe("/api/v1/namespaces/other/pods");
    expect(api.connections).toBe(1);
    const limits = { timeoutMs: 1000, maxBytes: 1024, maxTotalBytes: 1024 };
    expect(new TextDecoder().decode(fileBytes(await main.read(limits)))).toContain("sandbox-server");
    expect(new TextDecoder().decode(fileBytes(await secret.read(limits)))).toContain("sandbox-server");
    expect(reads).toBe(2);
    await root.dispose();
    await expect(main.read(limits)).rejects.toThrow();
  } finally {
    await Promise.all([first.dispose(), second.dispose(), denied.dispose()]);
    await root.dispose();
  }
});


test("native exec preflight checks GET pods/exec in addition to the declared exec capability", async () => {
  const commands: string[][] = [];
  const executor: Executor = {
    run: async args => {
      commands.push(args);
      return result(args, args.includes("get") ? "no" : "yes", !args.includes("get"));
    },
    exec: async () => { throw new Error("Preflight must not execute commands"); },
  };
  await expect(preflightPluginAccess(new KubernetesAccessContext(executor), "inspect", "demo", {
    access: { kubernetes: [{ requirement: "required", rule: { verb: "create", resource: "pods/exec", resourceName: "pod" }, purpose: "file" }] },
  })).rejects.toThrow("缺少必须");
  expect(commands.some(args => args.includes("get") && args.includes("pods/exec/pod"))).toBe(true);
});

function fileBytes(results: readonly FileReadResult[]): Uint8Array {
  const first = results[0]!;
  if (first.status === "error") throw first.error;
  return first.bytes;
}
