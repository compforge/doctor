import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function matchingFiles(root: string, pattern: RegExp): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return matchingFiles(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });
}

function sourceFiles(root: string): string[] {
  return matchingFiles(root, /\.(?:ts|tsx)$/);
}

test("Plugin SDK 与示例 Plugin 不反向依赖 CLI", () => {
  const roots = [
    join(import.meta.dir, "../src"),
    join(import.meta.dir, "../../../plugins/example/src"),
  ];
  for (const root of roots) {
    for (const path of sourceFiles(root)) {
      expect(readFileSync(path, "utf-8")).not.toMatch(/(?:from|import\()[^"'\n]*cli\//);
    }
  }
});

test("Plugin Skill 协议不依赖具体 Agent runtime", () => {
  for (const path of sourceFiles(join(import.meta.dir, "../src"))) {
    expect(readFileSync(path, "utf-8")).not.toMatch(/@compforge\/doctor-agent|pi-agent/);
  }
});

test("PluginContext 只暴露 Target-scoped Kubernetes access", () => {
  const source = readFileSync(join(import.meta.dir, "../src/context.ts"), "utf-8");
  expect(source).toMatch(/kubernetes:\s*KubernetesAccess/);
  expect(source).not.toMatch(/\bkubeconfig\b|\bkubeContext\b/);
});

test("CLI core 不依赖具体 Plugin 实现", () => {
  const root = join(import.meta.dir, "../../../cli/src");
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf-8");
    expect(source).not.toMatch(/@compforge\/doctor-plugin-/);
    expect(source).not.toMatch(/(?:from|import\()[^"'\n]*plugins\//);
  }
});

test("CLI core 不包含具体 Plugin 配置约定", () => {
  const cli = join(import.meta.dir, "../../../cli");
  const paths = [
    ...sourceFiles(join(cli, "src")),
    ...matchingFiles(join(cli, "docs"), /\.md$/),
    ...matchingFiles(join(cli, "examples"), /\.(?:md|ya?ml|py)$/),
    join(cli, "README.md"),
    join(cli, "config.yaml.example"),
  ];
  const privateTerms = /AgentSphere|MAAS_CONFIG_PATH|maas-config|X-Proxy-Tenant-ID|vke-system|control-server|iam-server|chat-server|sandbox-server|planit-server|agent-executor|xai-llm-app/i;
  for (const path of paths) {
    expect(readFileSync(path, "utf-8")).not.toMatch(privateTerms);
  }
});

test("config/data/log/trace collect 不按示例 Service 名分支", () => {
  const root = join(import.meta.dir, "../../../cli/src/collect");
  const exampleServices = /example-api|example-worker/i;
  for (const domain of ["config", "data", "log", "trace"]) {
    for (const path of sourceFiles(join(root, domain))) {
      expect(readFileSync(path, "utf-8")).not.toMatch(exampleServices);
    }
  }
});

test("MCP 私有配置访问不穿透到 CLI core", () => {
  const root = join(import.meta.dir, "../../../cli/src/collect/mcp");
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf-8");
    expect(source).not.toMatch(/McpConfigStorage|parseConfigStorage|mcp-config\.json/);
    expect(source).not.toMatch(/\["get",\s*"configmap"/);
  }
});

test("模型协议不暴露 Plugin 原始 backend 配置", () => {
  const roots = [
    join(import.meta.dir, "../src"),
    join(import.meta.dir, "../../../cli/src/collect/model"),
  ];
  const privateBackendFields = /\b(?:ModelID|ModelName|Credentials|Parameters|Features|AudioConfig|Property)\b/;
  for (const root of roots) {
    for (const path of sourceFiles(root)) {
      expect(readFileSync(path, "utf-8")).not.toMatch(privateBackendFields);
    }
  }
});
