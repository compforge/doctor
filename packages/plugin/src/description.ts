import type { CapabilityAccess } from "./kubernetes";
import type { ServiceDefinition, ServiceInspect } from "./service";
import type { ServiceDataSourceKind } from "./datasource";
import type { ServiceWorkloadDefinition } from "./workload";

/** A serializable declaration view, never a report of observed availability. */
export interface ServiceDescription {
  name: string;
  aliases: string[];
  description?: string;
  capabilities: string[];
  contributions: string[];
  details: {
    workloads: ServiceWorkloadDefinition[];
    dependencies: { id: string; service: string; capability: "dataSources"; dataSource: string }[];
    dataSources: { id: string; kind: ServiceDataSourceKind; backend: string; description?: string }[];
    inspect?: Pick<ServiceInspect, "description" | "limitations" | "accepts" | "provides" | "expands" | "dataSource">;
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
  const inspect = service.contributions?.inspect;
  const access: ServiceDescription["details"]["access"] = [];
  if (inspect) access.push({ owner: "contributions.inspect", requirements: describeAccess(inspect.access) });
  for (const name of ["overview", "traceId", "tenantDirectory", "modelCatalog", "inference", "case", "mcp"] as const) {
    const capability = service.capabilities[name];
    if (capability) access.push({ owner: `capabilities.${name}`, requirements: describeAccess(capability.access) });
  }
  for (const dataSource of service.capabilities.dataSources ?? []) {
    if (dataSource.access !== undefined) {
      access.push({ owner: `capabilities.dataSources.${dataSource.id}`, requirements: describeAccess(dataSource.access) });
    }
  }
  for (const probe of service.contributions?.probes ?? []) {
    if (probe.kind === "workload") {
      access.push({ owner: `contributions.probes.${probe.id}`, requirements: describeAccess(probe.access) });
    }
  }
  return {
    name: service.name,
    aliases: [...(service.aliases ?? [])],
    description: service.description,
    capabilities: Object.entries(service.capabilities).filter(([, value]) => value !== undefined).map(([name]) => name),
    contributions: Object.entries(service.contributions ?? {}).filter(([, value]) => value !== undefined).map(([name]) => name),
    details: {
      workloads: service.workloads.map(({ name, lifecycle, discovery, container }) => ({
        name, lifecycle, container,
        discovery: discovery.kind === "kubernetes-service"
          ? { kind: discovery.kind, service: discovery.service }
          : { kind: discovery.kind, labels: { ...discovery.labels } },
      })),
      dependencies: (service.dependencies ?? []).map(({ id, service, capability, dataSource }) => ({ id, service, capability, dataSource })),
      dataSources: (service.capabilities.dataSources ?? []).map(({ id, kind, backend, description }) => ({ id, kind, backend, description })),
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
