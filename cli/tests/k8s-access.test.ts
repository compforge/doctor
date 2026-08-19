import { expect, spyOn, test } from "bun:test";
import {
  KubernetesAccessContext,
  type KubernetesAccessContract,
} from "../src/infra/k8s/access";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";
import { CommandContext } from "../src/command";
import {
  enforceKubernetesAccess,
  requireKubernetesChannel,
} from "../src/terminal/kubernetes-access";

function result(stdout: string, ok = true): ExecResult {
  return {
    ok,
    exitCode: ok ? 0 : 1,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
  };
}

function commandContext(channel: NonNullable<CommandContext["inspection"]["kubernetes"]>["channel"]) {
  return new CommandContext({
    host: {
      platform: process.platform,
      architecture: process.arch,
      kernelRelease: "test",
      cpu: { logicalCount: 1 },
      totalMemoryBytes: 1,
      runtime: { name: "bun", version: "test" },
    },
    kubernetes: {
      kubeconfig: { source: "test" },
      channel,
    },
  });
}

test("KubernetesAccessContext 缓存权限探测并保留 preferred 事实", async () => {
  const calls: string[][] = [];
  const executor: Executor = {
    run: async (args) => {
      calls.push(args);
      return result("no\n", false);
    },
    exec: async () => result(""),
  };
  const context = new KubernetesAccessContext(executor);
  const contract: KubernetesAccessContract = {
    command: "doctor test",
    needs: [{
      requirement: "preferred",
      rule: { verb: "list", resource: "pods" },
      purpose: "提供 Pod 候选",
      fallback: "改为手动输入",
    }],
  };

  const first = await context.evaluate(contract);
  const second = await context.evaluate(contract);

  expect(first.runnable).toBe(true);
  expect(first.facts[0]?.status).toBe("denied");
  expect(context.fact({ verb: "list", resource: "pods" })?.status).toBe("denied");
  expect(second.facts[0]?.status).toBe("denied");
  expect(calls).toEqual([["auth", "can-i", "list", "pods"]]);
});

test("required 只有明确 denied 才阻止命令，unknown 交给实际操作裁决", async () => {
  const responses = [result("no\n", false), result("", false)];
  const executor: Executor = {
    run: async () => responses.shift()!,
    exec: async () => result(""),
  };
  const denied = new KubernetesAccessContext(executor);
  const contract: KubernetesAccessContract = {
    command: "doctor test",
    needs: [{
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "进入目标 Container",
    }],
  };

  expect((await denied.evaluate(contract)).runnable).toBe(false);
  expect((await new KubernetesAccessContext(executor).evaluate(contract)).runnable).toBe(true);
});

test("unknown 权限预检提示 namespace 和实际失败原因", async () => {
  const executor: Executor = {
    run: async () => ({
      ...result("", false),
      stderr: "selfsubjectaccessreviews.authorization.k8s.io is forbidden\nignored detail",
    }),
    exec: async () => result(""),
  };
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await enforceKubernetesAccess(new KubernetesAccessContext(executor), {
      command: "doctor data",
      namespace: "vke-system",
      needs: [{
        requirement: "required",
        rule: { verb: "get", resource: "services", resourceName: "chat-server" },
        purpose: "读取 chat-server 的 Pod selector",
      }],
    });

    expect(write).toHaveBeenCalledWith(
      "[k8s] required: get services/chat-server unknown"
      + "（读取 chat-server 的 Pod selector，namespace=vke-system）"
      + "；预检原因：selfsubjectaccessreviews.authorization.k8s.io is forbidden"
      + "；继续尝试实际操作\n",
    );
  } finally {
    write.mockRestore();
  }
});

test("resourceName 权限探测使用精确资源名", async () => {
  const calls: string[][] = [];
  const executor: Executor = {
    run: async (args) => {
      calls.push(args);
      return result("yes\n");
    },
    exec: async () => result(""),
  };

  await new KubernetesAccessContext(executor).inspect({
    verb: "get",
    resource: "pods",
    resourceName: "app-0",
  });

  expect(calls).toEqual([[
    "auth",
    "can-i",
    "get",
    "pods",
    "--resource-name=app-0",
  ]]);
});

test("CommandContext 按 executor 惰性复用 Kubernetes capability", () => {
  const executor: Executor = {
    run: async () => result("yes\n"),
    exec: async () => result(""),
  };
  const context = commandContext({
    available: false,
    client: result("", false),
    reason: "test",
  });

  expect(context.kubernetes(executor)).toBe(context.kubernetes(executor));
});

test("Kubernetes 通道校验复用启动 Inspect Fact，不重复执行 kubectl", async () => {
  let calls = 0;
  const executor: Executor = {
    run: async () => {
      calls++;
      return result("");
    },
    exec: async () => result(""),
  };
  const context = commandContext({
    available: true,
    client: result("{}"),
    server: result("{}"),
  });

  await requireKubernetesChannel({
    executor,
    profileName: "test",
    kubeconfigSource: "test",
    commandContext: context,
  });

  expect(calls).toBe(0);
});
