import { requireFactsInspectExtension, type FactsInspectExtension } from "./extension";
import type { CapabilityAccess } from "./kubernetes";
import type { ServiceDefinition } from "./service";
import type { ServiceDataSourceKind } from "./datasource";
import type { Workload } from "./workload";

/** A serializable declaration view, never a report of observed availability. */
export interface ServiceDescription {
  name: string;
  aliases: string[];
  description?: string;
  detectors: string[];
  environmentProbes: string[];
  extensions?: { id: string; kind: string; description?: string }[];
  cases?: { id: string; description?: string; produce: boolean; runner: boolean }[];
  details: {
    workloads: Workload[];
    dependencies: { id: string; service: string; dataSource: string }[];
    dataSources: { id: string; kind: ServiceDataSourceKind; backend: string; description?: string }[];
    inspect?: Pick<FactsInspectExtension, "description" | "limitations" | "accepts" | "provides" | "expands" | "dataSource">;
    access: { owner: string; requirements: CapabilityAccess }[];
  };
}

function describeAccess(access: CapabilityAccess): CapabilityAccess {
  return {
    kubernetes: (access.kubernetes ?? []).map(({ rule, requirement, purpose, fallback }) => ({
      rule: {
        verb: rule.verb,
        resource: rule.resource,
        resourceName: rule.resourceName,
        allNamespaces: rule.allNamespaces,
      },
      requirement, purpose, fallback,
    })),
  };
}

/**
 * @spec Project static declarations without invoking resolvers, factories, Inspect, Probe or Detector handlers.
 * @why Explicit field selection excludes endpoints, configuration and executable objects across the Plugin boundary.
 * @rule accepts describes input Identity kinds; provides/expands describe possible outputs, not guaranteed results.
 */
export function describeService(service: ServiceDefinition): ServiceDescription {
  const factsExtension = service.extensions?.find(extension => extension.kind === "facts.inspect");
  const inspect = factsExtension ? requireFactsInspectExtension(factsExtension) : undefined;
  const access: ServiceDescription["details"]["access"] = [];
  for (const extension of service.extensions ?? []) {
    access.push({ owner: `extensions.${extension.id}`, requirements: describeAccess(extension.access) });
  }
  for (const dataSource of service.dataSources ?? []) {
    if (dataSource.access !== undefined) {
      access.push({ owner: `dataSources.${dataSource.id}`, requirements: describeAccess(dataSource.access) });
    }
  }
  for (const source of service.cases ?? []) {
    for (const operation of ["produce", "runner"] as const) {
      if (source[operation]) access.push({ owner: `cases.${source.id}.${operation}`, requirements: describeAccess(source[operation].access) });
    }
  }
  return {
    name: service.name,
    aliases: [...(service.aliases ?? [])],
    description: service.description,
    detectors: (service.detectors ?? []).map(item => item.id),
    environmentProbes: (service.environmentProbes ?? []).map(item => item.id),
    ...(service.cases?.length ? { cases: service.cases.map(source => ({ id: source.id, description: source.description,
      produce: Boolean(source.produce), runner: Boolean(source.runner) })) } : {}),
    ...(service.extensions?.length ? { extensions: service.extensions.map(({ id, kind, description }) => ({ id, kind, description })) } : {}),
    details: {
      workloads: service.workloads.map(({ name, description, platform, namespace, location, container }) => ({
        name, description, platform, namespace, container,
        location: location.kind === "labels"
          ? { kind: location.kind, labels: { ...location.labels } }
          : location.kind === "resource"
            ? { kind: location.kind, resource_kind: location.resource_kind, name: location.name }
            : { kind: location.kind, name: location.name },
      })),
      dependencies: (service.dependencies ?? []).map(({ id, service, dataSource }) => ({ id, service, dataSource })),
      dataSources: (service.dataSources ?? []).map(({ id, kind, backend, description }) => ({ id, kind, backend, description })),
      inspect: inspect ? {
        description: inspect.description,
        limitations: [...(inspect.limitations ?? [])],
        accepts: [...inspect.accepts],
        provides: [...inspect.provides],
        expands: [...(inspect.expands ?? [])],
        dataSource: inspect.dataSource,
      } : undefined,
      access,
    },
  };
}
