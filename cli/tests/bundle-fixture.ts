import { expect } from "bun:test";

export interface BundleIndex {
  kind: string;
  artifacts: Array<{ id: string; command: string; path: string; report?: string }>;
}

export function readBundleText(archive: string, entry: string): string {
  const result = Bun.spawnSync(["tar", "-xOf", archive, entry]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

export function readBundleIndex(archive: string, root: string): BundleIndex {
  const index = JSON.parse(readBundleText(archive, `${root}/manifest.json`));
  expect(index.kind).toBe("doctor.bundle");
  return index;
}
