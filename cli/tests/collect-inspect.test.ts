import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { examplePlugin } from "../../plugins/example/src";
import {
  resolveInspectDeploymentSelection,
  resolveInspectDependencySelection,
  resolveInspectNamespaceSelection,
  runCollectInspect,
  type InspectConfig,
} from "../src/collect/inspect";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";
import { inspectContainerStateFact } from "../src/collect/inspect/fact/inspect";

function result(stdout = ""): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
  };
}

test("terminated state 只投影 Inspect Fact 声明的字段", () => {
  const state = inspectContainerStateFact({
    kind: "terminated",
    reason: "OOMKilled",
    exitCode: 137,
    containerId: "containerd://runtime-only",
  });

  expect(state).toMatchObject({ kind: "terminated", reason: "OOMKilled", exitCode: 137 });
  expect(state).not.toHaveProperty("containerId");
});

test("inspect 在缺省 Namespace 时复用交互选择", async () => {
  const config: InspectConfig = {
    namespace: "default",
    namespaceSource: "default",
    services: [],
    servicesExplicit: false,
    includeDeploymentConfig: false,
    includeDependencies: false,
    format: "html",
    reportName: "doctor-inspect-test",
    profileName: "default",
    kube: { namespace: "default", kubeconfig: "/tmp/kubeconfig" },
  };
  const executor: Executor = {
    run: async () => result(JSON.stringify({
      items: [
        { metadata: { name: "default" }, status: { phase: "Active" } },
        { metadata: { name: "vke-system" }, status: { phase: "Active" } },
      ],
    })),
    exec: async () => { throw new Error("unexpected exec"); },
  };
  expect(await resolveInspectNamespaceSelection({
    config,
    executor,
    interactive: true,
    prompt: async ({ choices, defaultNamespace, selection }) => {
      expect(choices.map((choice) => choice.name)).toEqual(["default", "vke-system"]);
      expect(defaultNamespace).toBe("default");
      expect(selection.purpose).toBe("确定 Service Inspect 范围");
      return "vke-system";
    },
  })).toMatchObject({
    namespace: "vke-system",
    namespaceSource: "prompt",
    kube: { namespace: "vke-system" },
  });
});

test("Deployment Env/ConfigMap 仅在 flag 或交互确认后采集", async () => {
  const config: InspectConfig = {
    namespace: "demo",
    namespaceSource: "default",
    services: ["example-api"],
    servicesExplicit: true,
    includeDeploymentConfig: false,
    includeDependencies: false,
    format: "html",
    reportName: "doctor-inspect-test",
    profileName: "default",
    kube: { namespace: "demo" },
  };
  expect(await resolveInspectDeploymentSelection({ config, interactive: false })).toBe(false);
  expect(await resolveInspectDeploymentSelection({
    config,
    interactive: true,
    prompt: async () => true,
  })).toBe(true);
  expect(await resolveInspectDeploymentSelection({
    config: { ...config, includeDeploymentConfig: true },
    interactive: false,
  })).toBe(true);
  expect(await resolveInspectDependencySelection({ config, interactive: false })).toBe(false);
  expect(await resolveInspectDependencySelection({
    config,
    interactive: true,
    prompt: async () => true,
  })).toBe(true);
  expect(await resolveInspectDependencySelection({
    config: { ...config, includeDependencies: true },
    interactive: false,
  })).toBe(true);
});

test("inspect 分别交付 workload、可选 Service 配置和 partial Coverage", async () => {
  const resources = {
    services: JSON.stringify({ items: [{
      metadata: { name: "example-api", namespace: "demo" },
      spec: { selector: { app: "example-api" }, ports: [{ port: 8080, targetPort: 8080 }] },
    }] }),
    deployments: JSON.stringify({ items: [{
      metadata: { name: "example-api" },
      spec: { template: { metadata: { labels: { app: "example-api" } }, spec: { containers: [{
        name: "example-api",
        ports: [{ containerPort: 8080 }],
        envFrom: [{ configMapRef: { name: "example-api" } }],
        env: [{ name: "LOG_LEVEL", value: "debug" }],
      }] } } },
    }] }),
    configmaps: JSON.stringify({ items: [{
      metadata: { name: "example-api" },
      data: { REQUEST_TIMEOUT: "30" },
    }] }),
    pods: JSON.stringify({ items: [{
      metadata: { namespace: "demo", name: "example-api-0", labels: { app: "example-api" } },
      spec: { containers: [{
        name: "example-api",
        image: "example.test/example-api:v1.2.3",
        resources: {
          requests: { cpu: "250m", memory: "256Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
      }] },
      status: {
        phase: "Running",
        conditions: [{
          type: "Ready",
          status: "False",
          reason: "ContainersNotReady",
          message: "containers with unready status: [example-api]",
        }],
        containerStatuses: [{
          name: "example-api",
          imageID: "example.test/example-api@sha256:1234",
          ready: false,
          restartCount: 12,
          state: {
            waiting: {
              reason: "CrashLoopBackOff",
              message: "back-off restarting failed container example-api",
            },
          },
          lastState: { terminated: {
            containerID: "containerd://previous",
            exitCode: 137,
            reason: "OOMKilled",
            finishedAt: "2026-08-19T02:00:00Z",
          } },
        }],
      },
    }] }),
  };
  const queriedResources: string[] = [];
  const dependencyCommands: string[][] = [];
  const executor: Executor = {
    run: async (args) => {
      const resource = args[1];
      if (resource) queriedResources.push(resource);
      if (resource && resource in resources) return result(resources[resource as keyof typeof resources]);
      throw new Error(`unexpected kubectl: ${args.join(" ")}`);
    },
    exec: async (_target, command) => {
      dependencyCommands.push(command);
      return result(JSON.stringify({
        runtimeVersion: "v22.0.0",
        dependencies: [{ name: "zod", version: "4.4.3" }],
      }));
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "doctor-inspect-test-"));
  try {
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "");
    const completeOutput = join(dir, "complete.md");
    expect(await runCollectInspect({
      namespace: "demo",
      services: "example-api",
      deploymentConfig: true,
      config: configPath,
      format: "md",
      output: completeOutput,
    }, examplePlugin, executor)).toBe(0);
    const complete = readFileSync(completeOutput, "utf-8");
    expect(complete).toContain("Deployment Env/ConfigMap：已采集");
    expect(complete).toContain("example.test/example-api:v1.2.3");
    expect(complete).toContain("250m");
    expect(complete).toContain("Ready=False: ContainersNotReady");
    expect(complete).toContain("restarts=12");
    expect(complete).toContain("waiting: CrashLoopBackOff");
    expect(complete).toContain("last=terminated: OOMKilled, exit=137");
    expect(complete).toContain("REQUEST_TIMEOUT");
    expect(complete).toContain("environment-config：sufficient");
    expect(complete).toContain("workload-runtime：sufficient");

    queriedResources.length = 0;
    const partialOutput = join(dir, "partial.md");
    expect(await runCollectInspect({
      namespace: "demo",
      services: "example-api",
      config: configPath,
      format: "md",
      output: partialOutput,
    }, examplePlugin, executor)).toBe(0);
    expect(queriedResources).not.toContain("deployments");
    expect(queriedResources).not.toContain("configmaps");
    const partial = readFileSync(partialOutput, "utf-8");
    expect(partial).toContain("Deployment Env/ConfigMap：未采集");
    expect(partial).toContain("environment-config：insufficient");
    expect(partial).toContain("workload-runtime：sufficient");
    expect(partial).toContain("用户未确认采集 Deployment Env/ConfigMap");

    const dependenciesOutput = join(dir, "dependencies.md");
    expect(await runCollectInspect({
      namespace: "demo",
      services: "example-api",
      dependencies: true,
      config: configPath,
      format: "md",
      output: dependenciesOutput,
    }, examplePlugin, executor)).toBe(0);
    expect(dependencyCommands).toHaveLength(1);
    expect(dependencyCommands[0]?.slice(0, 2)).toEqual(["node", "-e"]);
    const dependencies = readFileSync(dependenciesOutput, "utf-8");
    expect(dependencies).toContain("typescript");
    expect(dependencies).toContain("| Service | Runtime version | Dependency | Version |");
    expect(dependencies).not.toContain("| Service | Image | Runtime version");
    expect(dependencies).not.toContain("example.test/example-api@sha256:1234");
    expect(dependencies).toContain("example.test/example-api:v1.2.3");
    expect(dependencies).toContain("v22.0.0");
    expect(dependencies).toContain("zod");
    expect(dependencies).toContain("4.4.3");
    expect(dependencies).toContain("runtime-dependencies：sufficient");

    const pluginWithoutToolchain = {
      ...examplePlugin,
      services: createServiceCatalog([{
        name: "example-api",
        capabilities: {
          log: { default: true },
        },
      }]),
    } satisfies PluginDefinition;
    const unavailableOutput = join(dir, "dependencies-without-toolchain.md");
    const commandsBeforeUnavailable = dependencyCommands.length;
    expect(await runCollectInspect({
      namespace: "demo",
      services: "example-api",
      dependencies: true,
      config: configPath,
      format: "md",
      output: unavailableOutput,
    }, pluginWithoutToolchain, executor)).toBe(0);
    expect(dependencyCommands).toHaveLength(commandsBeforeUnavailable);
    const unavailable = readFileSync(unavailableOutput, "utf-8");
    expect(unavailable).toContain("Plugin 未声明 Toolchain");
    expect(unavailable).toContain("未声明");
    expect(unavailable).toContain("runtime-dependencies：insufficient");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
