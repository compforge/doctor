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

test("provision 不依赖 collect", () => {
  const root = join(import.meta.dir, "../src/provision");
  const collectImport = /\bfrom\s+["'][^"']*\/collect(?:\/[^"']*)?["']/;
  for (const path of sourceFiles(root)) {
    expect(readFileSync(path, "utf-8")).not.toMatch(collectImport);
  }
});
