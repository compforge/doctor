import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeScrapeTargets, summarizeScrapeTargets } from "@compforge/harness-toolbox/metricdb";
import { renderPerfReport, type ServiceScrapeCoverage } from "@compforge/perf-harness";
import { scrapeAdvice, scrapeGroupSummary } from "./scrape";
import type { PerfResult } from "./model";

/** Older bundles recorded only the selected Service. App labels can identify candidates, not prove workload membership. */
function savedScrapes(result: PerfResult): readonly ServiceScrapeCoverage[] {
  const scrape = result.scrape;
  if (!scrape) return [];
  if (scrape.services) return scrape.configError ? scrape.services.map(item => ({...item,
    issue:[item.issue,"config API：" + scrape.configError].filter(Boolean).join(" ")})) : scrape.services;
  const services = new Set((result.run.observation_bindings ?? []).map(binding => binding.service));
  services.delete(scrape.service);
  const coverage: ServiceScrapeCoverage[] = [{service:scrape.service, groups:scrape.groups, issue:scrape.targetsError ?? scrape.discoveryIssue}];
  if (scrape.targetsError) return [...coverage,...Array.from(services, service => ({service,groups:[],issue:"targets API：" + scrape.targetsError}))];
  const path = join(result.outputDir, "raw", "scrape", "targets.json");
  if (!existsSync(path)) return coverage;
  try {
    const targets = decodeScrapeTargets(JSON.parse(readFileSync(path,"utf8")).data, "active");
    for (const service of services) {
      const candidates = targets.filter(target => {
        const labels = target.discoveredLabels;
        return (labels?.__meta_kubernetes_namespace ?? target.labels?.namespace) === scrape.namespace
          && (labels?.__meta_kubernetes_pod_label_app_kubernetes_io_name ?? target.labels?.app_kubernetes_io_name) === service;
      });
      if (candidates.length) coverage.push({service, groups:summarizeScrapeTargets(candidates, []),
        issue:"旧归档按 namespace 和 app.kubernetes.io/name 列出候选 target，缺少当时的 Service selector，归属待核对。"});
    }
  } catch { for (const service of services) coverage.push({service,groups:[],issue:"归档的 targets 响应无法解析。"}); }
  return coverage;
}

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
  const html = renderPerfReport(result.run, { facetOrder, issues, scrapes:savedScrapes(result), metricBaseline:result.metricBaseline });
  const path = join(result.outputDir, "perf.html");
  writeFileSync(path, html);
  return path;
}
