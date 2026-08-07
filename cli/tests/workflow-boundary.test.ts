import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

test("共享 model 能力不依赖任何主路径", () => {
  const workflowImport = /\bfrom\s+["'][^"']*\/(?:provision|collect|chat)(?:\/[^"']*)?["']/;
  for (const path of sourceFiles(join(import.meta.dir, "../src/model"))) {
    expect(readFileSync(path, "utf-8")).not.toMatch(workflowImport);
  }
});
