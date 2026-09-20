import {
  OVERVIEW_SUMMARIZE_KIND, OVERVIEW_SAMPLE_KIND, requireOverviewSummarizeExtension, requireOverviewSampleExtension,
  type OverviewSummarizeExtension, type OverviewSampleExtension, type ServiceCatalog, type ServiceDefinition,
} from "@compforge/doctor-plugin";

export interface OverviewProvider {
  name: string;
  service: ServiceDefinition;
  summarize: OverviewSummarizeExtension;
  sample?: OverviewSampleExtension;
}

/** Results and sampling belong to one Service; multiple implementations of either operation are ambiguous. */
export function overviewProviders(catalog: ServiceCatalog): OverviewProvider[] {
  const summaries = catalog.extensions(OVERVIEW_SUMMARIZE_KIND);
  const samples = catalog.extensions(OVERVIEW_SAMPLE_KIND);
  const seen = new Set<string>();
  return summaries.map(({ service, extension }) => {
    const candidates = samples.filter(item => item.service.name === service.name);
    if (seen.has(service.name) || candidates.length > 1) throw new Error(`${service.name}: ambiguous overview Extension`);
    seen.add(service.name);
    return { name: service.name, service, summarize: requireOverviewSummarizeExtension(extension),
      sample: candidates[0] ? requireOverviewSampleExtension(candidates[0].extension) : undefined };
  });
}
