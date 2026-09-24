import { expect } from "bun:test";

import type { Manifest } from "../src/command/manifest";
import { posix } from "node:path";

export function readBundleText(archive: string, entry: string): string {
  const result = Bun.spawnSync(["tar", "-xOf", archive, entry]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

export function readBundleIndex(archive: string, root: string): Manifest {
  const index = JSON.parse(readBundleText(archive, `${root}/manifest.json`));
  expect(index.schemaVersion).toBe(2);
  return index;
}

export function readBundleExecutions(archive: string, root: string): Array<{ path: string; manifest: Manifest }> {
  const results: Array<{ path: string; manifest: Manifest }> = [];
  const visited = new Set<string>();
  const visit = (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const manifest = JSON.parse(readBundleText(archive, `${root}/${path}`)) as Manifest;
    expect(manifest.schemaVersion).toBe(2);
    results.push({ path, manifest });
    for (const child of manifest.children ?? []) visit(posix.join(posix.dirname(path), child.manifest));
  };
  visit("manifest.json");
  return results;
}
