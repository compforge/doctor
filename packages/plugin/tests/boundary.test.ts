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

test("config/data/log collect 不按示例 Service 名分支", () => {
  const root = join(import.meta.dir, "../../../cli/src/collect");
  const exampleServices = /example-api|example-worker/i;
  for (const domain of ["config", "data", "log"]) {
    for (const path of sourceFiles(join(root, domain))) {
      expect(readFileSync(path, "utf-8")).not.toMatch(exampleServices);
    }
  }
});
