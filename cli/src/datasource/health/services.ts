import { connectionDataSources } from "@compforge/doctor-plugin";
import { serviceDataSources, type PluginDefinition, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { ServiceDataSourceReference } from "../../collect/shared/service-dependency";

/** Select only sources owned by or explicitly depended on by this Service; never substitute another cluster. */
export function serviceHealthDataSources(plugin: PluginDefinition, service: ServiceDefinition): ServiceDataSourceReference[] {
  const references = [
    ...(connectionDataSources(service)).map(source => ({ service: service.name, dataSource: source.id })),
    ...(service.dependencies ?? []).map(dependency => ({ service: dependency.service, dataSource: dependency.dataSource })),
  ];
  const seen = new Set<string>();
  return references.filter(reference => {
    const source = serviceDataSources(plugin.services, reference.service, "vdb").find(source => source.id === reference.dataSource);
    if (source?.kind !== "vdb" || source.backend !== "opensearch") return false;
    const key = `${reference.service}/${reference.dataSource}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
