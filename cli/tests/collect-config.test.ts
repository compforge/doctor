import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { examplePlugin } from "../../plugins/example/src";
import {
  resolveConfigDeploymentSelection,
  runCollectConfig,
  type ConfigCollectConfig,
} from "../src/collect/config";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";

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

test("Deployment Env/ConfigMap 仅在 flag 或交互确认后采集", async () => {
  const config: ConfigCollectConfig = {
    namespace: "demo",
    namespaceSource: "default",
    services: ["example-api"],
    servicesExplicit: true,
    includeDeploymentConfig: false,
    format: "html",
    reportName: "doctor-config-test",
    profileName: "default",
    kube: { namespace: "demo" },
  };
  expect(await resolveConfigDeploymentSelection({ config, interactive: false })).toBe(false);
  expect(await resolveConfigDeploymentSelection({
    config,
    interactive: true,
    prompt: async () => true,
  })).toBe(true);
  expect(await resolveConfigDeploymentSelection({
    config: { ...config, includeDeploymentConfig: true },
    interactive: false,
  })).toBe(true);
});

test("config 分别交付 Pod 运行态、可选部署配置和 partial Coverage", async () => {
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
      status: { phase: "Running" },
    }] }),
  };
  const queriedResources: string[] = [];
  const executor: Executor = {
    run: async (args) => {
      const resource = args[1];
      if (resource) queriedResources.push(resource);
      if (resource && resource in resources) return result(resources[resource as keyof typeof resources]);
      throw new Error(`unexpected kubectl: ${args.join(" ")}`);
    },
    exec: async () => { throw new Error("Pod exec must not be used"); },
  };
  const dir = mkdtempSync(join(tmpdir(), "doctor-config-test-"));
  try {
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "");
    const completeOutput = join(dir, "complete.md");
    expect(await runCollectConfig({
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
    expect(complete).toContain("REQUEST_TIMEOUT");
    expect(complete).toContain("environment-config：sufficient");
    expect(complete).toContain("workload-runtime：sufficient");

    queriedResources.length = 0;
    const partialOutput = join(dir, "partial.md");
    expect(await runCollectConfig({
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
