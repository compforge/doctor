import { connectionDataSources, serviceDataSources, type PluginDefinition, type ServiceDefinition,
  type ServiceConnectionDataSource, type ServiceDataSourceKind } from "@compforge/doctor-plugin";
import type { ServiceDataSourceReference } from "../../collect/shared/service-dependency";

/** @spec Select only owned or explicitly depended-on sources, in declaration order, once per Service/source reference. */
function dataSourceReferences(plugin: PluginDefinition, service: ServiceDefinition, kind: ServiceDataSourceKind,
  accept?: (source: ServiceConnectionDataSource) => boolean): ServiceDataSourceReference[] {
  const references = [
    ...connectionDataSources(service).map(source => ({ service: service.name, dataSource: source.id })),
    ...(service.dependencies ?? []).map(dependency => ({ service: dependency.service, dataSource: dependency.dataSource })),
  ];
  const seen = new Set<string>();
  return references.filter(reference => {
    const source = serviceDataSources(plugin.services, reference.service, kind).find(source => source.id === reference.dataSource);
    if (!source || (accept && !accept(source))) return false;
    const key = `${reference.service}/${reference.dataSource}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function serviceHealthDataSources(plugin: PluginDefinition, service: ServiceDefinition): ServiceDataSourceReference[] {
  return dataSourceReferences(plugin, service, "vdb", source => source.kind === "vdb" && source.backend === "opensearch");
}

export function serviceHealthS3DataSources(plugin: PluginDefinition, service: ServiceDefinition): ServiceDataSourceReference[] {
  return dataSourceReferences(plugin, service, "s3");
}
