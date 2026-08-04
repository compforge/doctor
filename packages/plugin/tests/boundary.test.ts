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

test("Plugin SDK 不反向依赖 CLI", () => {
  const root = join(import.meta.dir, "../src");
  for (const path of sourceFiles(root)) {
    expect(readFileSync(path, "utf-8")).not.toMatch(/(?:from|import\()[^"'\n]*cli\//);
  }
});

test("CLI core 不依赖具体 Plugin 实现", () => {
  const root = join(import.meta.dir, "../../../cli/src");
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf-8");
    expect(source).not.toMatch(/@compforge\/doctor-plugin-/);
    expect(source).not.toMatch(/(?:from|import\()[^"'\n]*plugins\//);
  }
});

test("CLI core 不包含具体产品配置约定", () => {
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

test("config/data/log collect 不按示例 Service 名分支", () => {
  const root = join(import.meta.dir, "../../../cli/src/collect");
  const exampleServices = /example-api|example-worker/i;
  for (const domain of ["config", "data", "log"]) {
    for (const path of sourceFiles(join(root, domain))) {
      expect(readFileSync(path, "utf-8")).not.toMatch(exampleServices);
    }
  }
});
