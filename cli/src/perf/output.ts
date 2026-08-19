import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PerfConfig } from "./model";

export interface PerfArtifact {
  path: string;
  temporaryRoot: string;
}

export function createPerfArtifact(config: PerfConfig): PerfArtifact {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "doctor-perf-"));
  const path = join(temporaryRoot, config.bundleName);
  mkdirSync(path, { recursive: true });
  return { path, temporaryRoot };
}
