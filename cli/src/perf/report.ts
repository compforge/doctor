import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { renderPerfReport } from "@compforge/perf-harness";
import type { PerfResult } from "./model";

/** The Harness owns performance views; Doctor owns Artifact delivery and coverage notes. */
export function writePerfReport(result: PerfResult): string {
  const path = join(result.outputDir, "perf.html");
  writeFileSync(path, renderPerfReport(result.run, {issues:result.metricIssues, facetOrder:Object.fromEntries(
    Object.entries(result.caseFacets ?? {}).filter(([,spec]) => spec.ordered && spec.values)
      .map(([key,spec]) => [key,spec.values!])
  )}));
  return path;
}
