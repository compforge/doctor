import { expect, test } from "bun:test";

import { KubernetesAccessContext } from "../src/infra/k8s/access";
import { createPluginContext, openPluginContext } from "../src/plugin/context";
import type {
  ExecResult,
  Executor,
  RunOptions,
} from "../src/infra/k8s/executor";

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
  const context = createPluginContext(executor, {
    kubeconfig: "/tmp/test-kubeconfig",
    context: "test-context",
    namespace: "default",
  }, {
    env: "test",
    config: { region: "sample" },
    service: { name: "sample-api" },
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
  expect(context.target).toEqual({
    env: "test",
    namespace: "default",
    service: { name: "sample-api" },
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
  expect(calls.every(({ options }) => options?.signal === context.signal)).toBe(true);

  await context.dispose();
  expect(context.signal.aborted).toBe(true);
});

test("Plugin Kubernetes access normalizes command failures", async () => {
  const executor: Executor = {
    run: async (command) => result(command, "", false),
    exec: async (_target, command) => result(command, "", false),
  };
  const context = createPluginContext(executor, { namespace: "default" }, {
    env: "test",
    service: { name: "sample-api" },
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
    env: "test",
    service: { name: "selected-api" },
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
    env: "test",
    service: { name: "selected-api" },
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
    env: "test",
    service: { name: "selected-api" },
    capability: { access: {} },
  });

  await expect(context.infra.kubernetes.get("secrets", "sample"))
    .rejects.toThrow("未声明 Kubernetes access: get secrets");
  await context.dispose();
});

test("Plugin Kubernetes access enforces the Core output limit", async () => {
  const executor: Executor = {
    run: async (command) => result(command, "x".repeat(4 * 1024 * 1024 + 1)),
    exec: async (_target, command) => result(command),
  };
  const context = createPluginContext(executor, { namespace: "default" }, {
    env: "test",
    service: { name: "sample-api" },
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
