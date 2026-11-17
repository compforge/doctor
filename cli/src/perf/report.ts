import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { renderPerfReport } from "@compforge/perf-harness";
import type { PerfResult } from "./model";

/** @spec Harness owns report tables; Doctor supplies coverage issues and declared Facet ordering. */
export function writePerfReport(result: PerfResult): string {
  const facetOrder = Object.fromEntries(Object.entries(result.caseFacets ?? {})
    .filter(([, facet]) => facet.ordered && facet.values)
    .map(([name, facet]) => [name, facet.values!]));
  const html = renderPerfReport(result.run, { issues: result.metricIssues, facetOrder });
  const path = join(result.outputDir, "perf.html");
  writeFileSync(path, html);
  return path;
}
