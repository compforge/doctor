import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

test("perf 只编排 collect 的稳定信号入口，不依赖 provision 或 chat", () => {
  const sources = sourceFiles(join(import.meta.dir, "../src/perf"))
    .map((path) => readFileSync(path, "utf-8"))
    .join("\n");

  expect(sources).not.toMatch(/\bfrom\s+["'][^"']*\/(?:provision|chat)(?:\/[^"']*)?["']/);
  expect(sources).toContain('from "../collect/metric"');
  expect(sources).toContain('from "../collect/trace"');
  expect(sources).toContain('from "../collect/log"');
});

test("共享 model 能力不依赖任何主路径", () => {
  const workflowImport = /\bfrom\s+["'][^"']*\/(?:provision|collect|perf|chat)(?:\/[^"']*)?["']/;
  for (const path of sourceFiles(join(import.meta.dir, "../src/model"))) {
    expect(readFileSync(path, "utf-8")).not.toMatch(workflowImport);
  }
});

test("doctor model 与 doctor tenant 不依赖彼此的 command 实现", () => {
  const collectRoot = resolve(import.meta.dir, "../src/collect");
  for (const [command, peer] of [["model", "tenant"], ["tenant", "model"]] as const) {
    const peerRoot = join(collectRoot, peer);
    for (const path of sourceFiles(join(collectRoot, command))) {
      const source = readFileSync(path, "utf-8");
      for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (!specifier?.startsWith(".")) continue;
        const target = resolve(dirname(path), specifier);
        expect(target === peerRoot || target.startsWith(`${peerRoot}/`)).toBe(false);
      }
    }
  }
});
