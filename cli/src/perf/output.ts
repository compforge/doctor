import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceCaseRef } from "@compforge/doctor-plugin";
import type { PerfConfig, PerfResult } from "./model";

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

export interface PerfMetadata {
  metricBaseline?: PerfResult["metricBaseline"];
  scrape?: PerfResult["scrape"];
  service?: string;
  caseCounts?: Record<string, number>;
  caseEntries?: Record<string, string>;
  caseRefs?: Record<string, string>;
  caseSource?: ServiceCaseRef;
  operation: string;
  caseFacets: NonNullable<PerfResult["caseFacets"]>;
  caseIds: readonly string[];
}

/** Persist Doctor-owned Case metadata and metric coverage beside the Harness Run. */
export function writePerfMetadata(directory: string, metadata: PerfMetadata,
  metrics?: Pick<PerfResult, "metricsComplete" | "metricIssues">,
): void {
  writeFileSync(join(directory, "perf.json"), JSON.stringify({ schema: 1, ...metadata, ...metrics }, null, 2));
}
