import { FACTS_INSPECT_KIND, requireFactsInspectExtension, type FactsInspectExtension, type ServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";

export interface DataProvider {
  name: string;
  service: ServiceDefinition;
  extension: FactsInspectExtension;
}

/** Data currently attributes one facts.inspect producer per Service; ambiguity is never resolved by order. */
export function dataProviders(catalog: ServiceCatalog, serviceName?: string): DataProvider[] {
  const seen = new Set<string>();
  return catalog.extensions(FACTS_INSPECT_KIND).filter(item => serviceName === undefined || item.service.name === serviceName).map(({ service, extension }) => {
    if (seen.has(service.name)) throw new Error(`Data requires one facts.inspect Extension per Service: '${service.name}'`);
    seen.add(service.name);
    return { name: service.name, service, extension: requireFactsInspectExtension(extension) };
  });
}

export function findDataProvider(catalog: ServiceCatalog, name: string): DataProvider | undefined {
  const canonical = catalog.find(name)?.name;
  return canonical === undefined ? undefined : dataProviders(catalog, canonical)[0];
}
