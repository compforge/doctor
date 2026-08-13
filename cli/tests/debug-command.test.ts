import { expect, test } from "bun:test";
import { CommandContext } from "../src/command";
import {
  formatExistingDebugContainers,
  recordCreatedDebugEnvironment,
  resolveDebugInstallFollowUp,
  resolveBatchDebugImage,
  resolveDebugBatchOptions,
  resolveSelectedDebugPods,
} from "../src/provision/debug";
import type { PodChoice } from "../src/infra/k8s/pod-selection";
import { formatDoctorDebugCommand } from "../src/terminal/debug-recommendation";

const pods: PodChoice[] = [
  {
    name: "frontend-0",
    phase: "Running",
    ready: "1/1",
    restarts: 0,
    containers: [{ name: "chat", image: "chat:1" }],
  },
  {
    name: "planner-0",
    phase: "Running",
    ready: "2/2",
    restarts: 1,
    containers: [
      { name: "agent", image: "planner:1" },
      { name: "sidecar", image: "sidecar:1" },
    ],
  },
];

test("doctor debug 将交互多选的 Pod 解析成批量准备目标", () => {
  const resolved = resolveSelectedDebugPods(
    pods,
    ["frontend-0", "planner-0"],
  );

  expect([...resolved.targets]).toEqual([
    ["frontend-0", "chat"],
    ["planner-0", "agent"],
  ]);
  expect(resolved.errors).toEqual([]);
  expect(resolved.warnings[0]).toContain("planner-0 有多个业务容器");
});

test("doctor debug 批量指定 container 时逐 Pod 校验", () => {
  const resolved = resolveSelectedDebugPods(
    pods,
    ["frontend-0", "planner-0"],
    "agent",
  );

  expect([...resolved.targets]).toEqual([["planner-0", "agent"]]);
  expect(resolved.errors).toEqual(["pod/frontend-0 中不存在 container 'agent'"]);
});

test("doctor debug 批量流程复用首次确认的 Kubernetes scope", () => {
  expect(resolveDebugBatchOptions(
    { profile: "demo", image: "registry/doctor-debug:1" },
    {
      profileName: "demo",
      kubernetes: {
        namespace: "default",
        namespaceSource: "prompt",
        kubeconfig: "/tmp/demo-kubeconfig",
        kubeconfigSource: "profile",
        context: "dev-context",
      },
    },
  )).toMatchObject({
    profile: "demo",
    image: "registry/doctor-debug:1",
    namespace: "default",
    kubeconfig: "/tmp/demo-kubeconfig",
    context: "dev-context",
  });
});

test("doctor debug 批量流程按目标平台复用已验证的 image", async () => {
  const cache = new Map();
  let prepared = 0;
  const prepare = async () => {
    prepared += 1;
    return { code: 0, image: "registry.example.com/ops/doctor-debug:1-linux-amd64" };
  };
  const platform = { os: "linux" as const, architecture: "amd64" as const };

  const first = await resolveBatchDebugImage(cache, platform, prepare);
  const second = await resolveBatchDebugImage(cache, platform, prepare);

  expect(prepared).toBe(1);
  expect(first.reused).toBe(false);
  expect(second.reused).toBe(true);
  expect(second.prepared).toEqual(first.prepared);
});

test("doctor debug 不跨 Pod 缓存目标业务镜像 fallback", async () => {
  const cache = new Map();
  let prepared = 0;
  const prepare = async () => ({
    code: 0,
    source: "target-image" as const,
    image: `app:${++prepared}`,
  });
  const platform = { os: "linux" as const, architecture: "amd64" as const };

  const first = await resolveBatchDebugImage(cache, platform, prepare);
  const second = await resolveBatchDebugImage(cache, platform, prepare);

  expect(first.prepared.image).toBe("app:1");
  expect(second.prepared.image).toBe("app:2");
  expect(second.reused).toBe(false);
});

test("doctor debug 再次执行时打印 Pod 中已有的 debug 临时容器", () => {
  const output = formatExistingDebugContainers("app-0", [
    {
      kind: "ephemeral-container",
      executionContainer: "doctor-debug-old",
      image: "registry.example.com/doctor-debug:0.0.10",
      targetContainer: "app",
      state: "running",
      capabilities: ["SYS_PTRACE"],
      compatible: true,
    },
    {
      kind: "ephemeral-container",
      executionContainer: "doctor-debug-new",
      image: "registry.example.com/doctor-debug:0.0.12",
      targetContainer: "app",
      state: "running",
      capabilities: ["SYS_PTRACE", "NET_RAW"],
      compatible: true,
    },
  ], "doctor-debug-new");

  expect(output).toContain("已有 2 个 doctor debug 临时容器");
  expect(output).toContain("doctor-debug-old");
  expect(output).toContain("doctor-debug-new");
  expect(output).toContain("← 优先候选");
  expect(output).toContain("不支持原地删除或替换");
});

test("doctor debug 新建容器后把本地 package tar 交给精确 install 目标", () => {
  const commandContext = new CommandContext({});
  recordCreatedDebugEnvironment(commandContext, {
    namespace: "planit",
    pod: "planit-server-0",
    targetContainer: "planit-server",
    executionContainer: "doctor-debug-new",
    capabilities: ["SYS_PTRACE"],
  });
  const followUp = resolveDebugInstallFollowUp({
    interactive: true,
    bundles: [{
      path: "/work/doctor-packages-0.0.4-debian12.tar",
      manifest: {
        schema: "doctor-packages/v1",
        bundleVersion: "0.0.4",
        packageManager: "apt-get",
        osId: "debian",
        osVersionId: "12",
        architecture: "arm64",
        packages: ["gdb"],
      },
    }],
    opts: {
      profile: "customer",
      kubeconfig: "/work/kubeconfig",
      context: "prod",
      yes: true,
    },
    commandContext,
    target: {
      namespace: "planit",
      pod: "planit-server-0",
      container: "planit-server",
    },
  });

  expect(followUp).toEqual({
    packageTars: ["/work/doctor-packages-0.0.4-debian12.tar"],
    install: {
      profile: "customer",
      config: undefined,
      namespace: "planit",
      kubeconfig: "/work/kubeconfig",
      context: "prod",
      pod: "planit-server-0",
      container: "doctor-debug-new",
      program: "gdb",
    },
  });
  expect(followUp?.install.yes).toBeUndefined();
});

test("doctor debug 不在无 package tar 或非交互环境触发安装", () => {
  const commandContext = new CommandContext({});
  recordCreatedDebugEnvironment(commandContext, {
    namespace: "default",
    pod: "app-0",
    targetContainer: "app",
    executionContainer: "doctor-debug-new",
    capabilities: ["SYS_PTRACE"],
  });
  const input = {
    opts: {},
    commandContext,
    target: { namespace: "default", pod: "app-0", container: "app" },
  };
  expect(resolveDebugInstallFollowUp({
    ...input,
    interactive: true,
    bundles: [],
  })).toBeUndefined();
  expect(resolveDebugInstallFollowUp({
    ...input,
    interactive: false,
    bundles: [{
      path: "/work/doctor-packages.tar",
      manifest: {
        schema: "doctor-packages/v1",
        bundleVersion: "1",
        packageManager: "apt-get",
        osId: "debian",
        osVersionId: "12",
        architecture: "amd64",
        packages: ["gdb"],
      },
    }],
  })).toBeUndefined();
});

test("doctor debug 不为仅抓包的新容器进入 GDB 安装", () => {
  const commandContext = new CommandContext({});
  recordCreatedDebugEnvironment(commandContext, {
    namespace: "default",
    pod: "app-0",
    targetContainer: "app",
    executionContainer: "doctor-debug-net",
    capabilities: ["NET_RAW"],
  });

  expect(resolveDebugInstallFollowUp({
    interactive: true,
    bundles: [{
      path: "/work/doctor-packages.tar",
      manifest: {
        schema: "doctor-packages/v1",
        bundleVersion: "1",
        packageManager: "apt-get",
        osId: "debian",
        osVersionId: "12",
        architecture: "amd64",
        packages: ["gdb"],
      },
    }],
    opts: {},
    commandContext,
    target: { namespace: "default", pod: "app-0", container: "app" },
  })).toBeUndefined();
});

test("缺少 debug environment 时可把既有 Service 或 Pod 选择渲染为 debug 命令", () => {
  expect(formatDoctorDebugCommand({
    profileName: "demo",
    namespace: "default",
    services: ["frontend", "planner"],
  })).toBe(
    "mono-doctor doctor debug --profile demo -n default --services frontend,planner",
  );
  expect(formatDoctorDebugCommand({
    profileName: "demo profile",
    namespace: "default",
    pod: "frontend-0",
    container: "chat",
  })).toBe(
    "mono-doctor doctor debug --profile 'demo profile' -n default -p frontend-0 -c chat",
  );
});
