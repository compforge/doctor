import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { renderPerfReport } from "@compforge/perf-harness";
import { scrapeAdvice, scrapeGroupSummary } from "./scrape";
import type { PerfResult } from "./model";

/** @spec Harness owns report tables; Doctor supplies coverage issues and declared Facet ordering. */
export function writePerfReport(result: PerfResult): string {
  const facetOrder = Object.fromEntries(Object.entries(result.caseFacets ?? {})
    .filter(([, facet]) => facet.ordered && facet.values)
    .map(([name, facet]) => [name, facet.values!]));
  const scrape = result.scrape;
  const issues = [...result.metricIssues ?? []];
  if (scrape) {
    issues.push(...scrape.groups.map(scrapeGroupSummary), ...scrapeAdvice(scrape, result.run.executions[0]?.arm.load.hold_s));
  }
  const html = renderPerfReport(result.run, { facetOrder, issues });
  const path = join(result.outputDir, "perf.html");
  writeFileSync(path, html);
  return path;
}
