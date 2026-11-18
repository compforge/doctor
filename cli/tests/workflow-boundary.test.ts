import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("CLI 的 provision、collect 与 chat 三条主路径互不依赖", () => {
  const workflows = ["provision", "collect", "chat"];
  for (const workflow of workflows) {
    const peers = workflows.filter((candidate) => candidate !== workflow).join("|");
    const peerImport = new RegExp(`\\bfrom\\s+["'][^"']*/(?:${peers})(?:/[^"']*)?["']`);
    for (const path of sourceFiles(join(import.meta.dir, `../src/${workflow}`))) {
      expect(readFileSync(path, "utf-8")).not.toMatch(peerImport);
    }
  }
});

test("perf 通过 Harness 与外部指标协议采集，不调用 collect 信号命令", () => {
  const sources = sourceFiles(join(import.meta.dir, "../src/perf"))
    .map((path) => readFileSync(path, "utf-8"))
    .join("\n");

  expect(sources).not.toMatch(/\bfrom\s+["'][^"']*\/(?:provision|chat)(?:\/[^"']*)?["']/);
  expect(sources).not.toMatch(/\bfrom\s+["'][^"']*\/collect\/(?:trace|log)\/command["']/);
  expect(sources).toContain('from "@compforge/harness-toolbox/metricdb"');
});

test("eval 只编排 Case 与 collect 的稳定数据入口，不依赖 provision、perf 或 chat", () => {
  const sources = sourceFiles(join(import.meta.dir, "../src/eval"))
    .map((path) => readFileSync(path, "utf-8"))
    .join("\n");

  expect(sources).not.toMatch(/\bfrom\s+["'][^"']*\/(?:provision|perf|chat)(?:\/[^"']*)?["']/);
  expect(sources).toContain('from "../case"');
  expect(sources).toContain('from "../collect/trace/command"');
  expect(sources).toContain('from "../collect/log/command"');
  expect(sources).toContain('from "../collect/data/command"');
});

test("共享 model 能力不依赖任何主路径", () => {
  const workflowImport = /\bfrom\s+["'][^"']*\/(?:provision|collect|eval|perf|chat)(?:\/[^"']*)?["']/;
  for (const path of sourceFiles(join(import.meta.dir, "../src/model"))) {
    expect(readFileSync(path, "utf-8")).not.toMatch(workflowImport);
  }
});

test("Collect domain 不得绕过 runCollect 调用低层 runner", () => {
  const collectRoot = resolve(import.meta.dir, "../src/collect");
  const lowLevelRunner = /\b(?:runDiagnosis|runInspects|runProbes|runDetectors)\b/;
  const directCallers = sourceFiles(collectRoot)
    .filter((path) => path !== join(collectRoot, "engine.ts"))
    .filter((path) => {
      const source = readFileSync(path, "utf-8");
      return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g)]
        .some((match) => lowLevelRunner.test(match[1] ?? ""));
    })
    .map((path) => relative(collectRoot, path))
    .sort();

  expect(directCallers).toEqual([]);
});
