import { expect, spyOn, test } from "bun:test";

import { KubernetesAccessContext } from "../src/infra/k8s/access";
import { createPluginContext, openPluginContext } from "../src/plugin/context";
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

test("Plugin Kubernetes access is target-scoped and Core-owned", async () => {
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
    kubeconfig: "/tmp/test-kubeconfig",
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

  expect(await context.infra.kubernetes.get<{ kind: string }>("services", "sample-api"))
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
    kind: "run",
    command: ["get", "services", "sample-api", "-o", "json"],
  }, {
    kind: "exec",
    command: ["sample-api-0", "env"],
  }]);
  expect(calls.every(({ options }) => options?.timeoutMs === 20_000)).toBe(true);
  expect(calls.every(({ options }) => options?.signal?.aborted === false)).toBe(true);

  await context.dispose();
  expect(context.signal.aborted).toBe(true);
});

test("Plugin Kubernetes access normalizes command failures", async () => {
  const executor: Executor = {
    run: async (command) => result(command, "", false),
    exec: async (_target, command) => result(command, "", false),
  };
  const context = createPluginContext(executor, { namespace: "default" }, {
    environment: { name: "cluster-test", kind: "kubernetes", context: "test-context", server: "https://cluster.test/" },
    service: {
      name: "sample-api",
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
      workloads: []
    },
    capability: {
      access: {
        kubernetes: [{
          rule: { verb: "get", resource: "secrets" },
          requirement: "required",
          purpose: "test",
        }],
      },
    },
  });

  await expect(context.infra.kubernetes.get("secrets", "sample"))
    .rejects.toThrow("kubectl -n default get secrets sample -o json 失败：forbidden");
  await context.dispose();
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

  await expect(context.infra.kubernetes.get("secrets", "sample"))
    .rejects.toThrow("未声明 Kubernetes access: get secrets");
  await expect(context.infra.kubernetes.inNamespace("other").get("secrets", "sample"))
    .rejects.toThrow("未声明 Kubernetes access: get secrets");
  await context.dispose();
});

test("Plugin Kubernetes access enforces the Core output limit", async () => {
  const executor: Executor = {
    run: async (command) => result(command, "x".repeat(4 * 1024 * 1024 + 1)),
    exec: async (_target, command) => result(command),
  };
  const context = createPluginContext(executor, { namespace: "default" }, {
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

  await expect(context.infra.kubernetes.get("configmaps", "sample"))
    .rejects.toThrow("输出超过 4194304 bytes");
  await context.dispose();
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
      const context = createPluginContext(executor, { namespace: "test" }, options);
      const client = await context.clients.get({
        clientKey: "db", createClient: resource => ({
          initialize: async () => { discoveries++; },
          dispose: async () => { closed++; },
          query: async (id: string) => {
            await resource.infra.kubernetes.get("services", "api");
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
          await expect(distinct.resource.infra.kubernetes.get("services", "api")).rejects.toThrow("未声明");
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
