import { vdbTargetProviders } from "../datasource/vdb-extension";
import { workloadProbeProviders } from "./workload-extensions";
import {
  createServiceCatalog,
  isToolchain,
  type PluginDefinition,
  type ServiceDefinition,
} from "@compforge/doctor-plugin";
import type { PluginManifest } from "./manifest";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonEmptyArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value;
}

function uniqueIdRecords(value: unknown, label: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const [index, item] of nonEmptyArray(value, label).entries()) {
    const candidate = record(item, `${label}[${index}]`);
    const id = nonEmptyString(candidate.id, `${label}[${index}].id`);
    if (result.has(id)) throw new Error(`${label} contains duplicate id '${id}'`);
    result.set(id, candidate);
  }
  return result;
}

function validateService(value: unknown, index: number): ServiceDefinition {
  const service = record(value, `Plugin Service[${index}]`);
  nonEmptyString(service.name, `Plugin Service[${index}].name`);
  if (service.description !== undefined) nonEmptyString(service.description, `${service.name}.description`);
  if (!Array.isArray(service.workloads)) {
    throw new Error(`Plugin Service '${String(service.name)}'.workloads must be an array`);
  }
  const component = record(service.component, service.name + ".component");
  nonEmptyString(component.name, service.name + ".component.name");
  const repository = record(component.repository, service.name + ".component.repository");
  nonEmptyString(repository.path, service.name + ".component.repository.path");
  const forge = record(repository.forge, service.name + ".component.repository.forge");
  nonEmptyString(forge.name, service.name + ".component.repository.forge.name");
  if (service.environment !== undefined) throw new Error(service.name + ".environment is bound by Doctor, not the Catalog");
  const workloadNames = new Set<string>();
  for (const [workloadIndex, value] of service.workloads.entries()) {
    const workload = record(value, `${service.name}.workloads[${workloadIndex}]`);
    const name = nonEmptyString(workload.name, `${service.name}.workloads[${workloadIndex}].name`);
    if (workloadNames.has(name)) throw new Error(`${service.name}.workloads contains duplicate name '${name}'`);
    workloadNames.add(name);
    const label = service.name + ".workloads." + name;
    if (workload.platform !== "kubernetes") throw new Error(label + ".platform must be kubernetes");
    if (workload.description !== undefined) nonEmptyString(workload.description, label + ".description");
    if (workload.namespace !== undefined) nonEmptyString(workload.namespace, label + ".namespace");
    if (workload.container !== undefined) nonEmptyString(workload.container, label + ".container");
    const location = record(workload.location, label + ".location");
    if (location.kind === "service" || location.kind === "resource") {
      nonEmptyString(location.name, label + ".location.name");
      if (location.kind === "resource" && !["Deployment", "StatefulSet", "DaemonSet", "Pod"].includes(String(location.resource_kind))) {
        throw new Error(label + ".location.resource_kind is unsupported");
      }
    } else if (location.kind === "labels") {
      const labels = record(location.labels, label + ".location.labels");
      if (!Object.keys(labels).length) throw new Error(label + ".location.labels must not be empty");
      for (const [key, value] of Object.entries(labels)) {
        nonEmptyString(key, label + ".location.labels key");
        if (typeof value !== "string") throw new Error(label + ".location.labels." + key + " must be a string");
      }
    } else {
      throw new Error(label + ".location.kind is unsupported");
    }
  }
  if (service.toolchain !== undefined && !isToolchain(service.toolchain)) {
    throw new Error(`Plugin Service '${String(service.name)}'.toolchain is invalid`);
  }
  if (service.dependencies !== undefined) {
    for (const [dependencyIndex, value] of nonEmptyArray(
      service.dependencies,
      `Plugin Service '${String(service.name)}'.dependencies`,
    ).entries()) {
      const dependency = record(
        value,
        `Plugin Service '${String(service.name)}'.dependencies[${dependencyIndex}]`,
      );
      nonEmptyString(dependency.id, `${service.name}.dependencies[${dependencyIndex}].id`);
      nonEmptyString(dependency.service, `${service.name}.dependencies[${dependencyIndex}].service`);
      nonEmptyString(dependency.dataSource, `${service.name}.dependencies[${dependencyIndex}].store`);
    }
  }
  if (service.capabilities !== undefined || service.contributions !== undefined) throw new Error(`${service.name}: unsupported Service API; declare extensions, dataSources and detectors`);
  if (service.configurationInspection !== undefined && typeof service.configurationInspection !== "boolean") throw new Error(`${service.name}.configurationInspection must be a boolean`);
  if (service.logs !== undefined) {
    const logs = record(service.logs, `${service.name}.logs`);
    if (typeof logs.default !== "boolean") throw new Error(`${service.name}.logs.default must be a boolean`);
  }
  if (service.detectors !== undefined) {
    for (const [detectorId, detector] of uniqueIdRecords(
      service.detectors,
      `${service.name}.detectors`,
    )) {
      if (typeof detector.detect !== "function") {
        throw new Error(`${service.name}.detectors.${detectorId}.detect must be a function`);
      }
    }
  }
  if (service.environmentProbes !== undefined) {
    for (const [probeId, probe] of uniqueIdRecords(
      service.environmentProbes,
      `${service.name}.environmentProbes`,
    )) {
      const label = `${service.name}.environmentProbes.${probeId}`;
      if (probe.kind === "kubernetes.apparmor-unconfined-admission") {
        if (probe.schemaVersion !== 1) {
          throw new Error(`${label} uses unsupported schemaVersion '${String(probe.schemaVersion)}'`);
        }
        if (probe.subject !== "workload-service-account") {
          throw new Error(`${label} uses unsupported subject '${String(probe.subject)}'`);
        }
      } else {
        throw new Error(`${label} uses unsupported kind '${String(probe.kind)}'`);
      }
    }
  }
  if (service.dataSources !== undefined) {
    const dataSources = uniqueIdRecords(service.dataSources, `${service.name}.dataSources`);
    for (const [id, store] of dataSources) {
      if (store.description !== undefined) nonEmptyString(store.description, `${service.name}.dataSources.${id}.description`);
      const label = `${service.name}.dataSources.${id}`;
      const resolver = store.source !== undefined;
      if (resolver) {
        const source = record(store.source, `${label}.source`);
        nonEmptyString(source.clientKey, `${label}.source.clientKey`);
        if (typeof source.createClient !== "function") throw new Error(`${label}.source.createClient must be a function`);
      }
      if (store.kind === "db") {
        if (store.backend !== "mysql") throw new Error(`${label}.backend must be mysql`);
        const env = store.envPrefix !== undefined;
        if (env === resolver) throw new Error(`${label} must declare exactly one of envPrefix / source`);
        if (env) nonEmptyString(store.envPrefix, `${label}.envPrefix`);
        if ("inspectTarget" in store) throw new Error(`${label}.inspectTarget is unsupported; declare source`);
      }
      if (store.kind === "s3" || store.kind === "redis") {
        if (resolver === (store.environment !== undefined)) throw new Error(`${label} must declare exactly one of environment / source`);
        if (!resolver) record(store.environment, `${label}.environment`);
      }
      if (store.kind === "vdb" && resolver && (store.configuration !== undefined)) {
        throw new Error(`${label}.source cannot be combined with inspectTarget / configuration`);
      }
      if (store.access !== undefined) record(store.access, `${label}.access`);
    }
  }
  return service as unknown as ServiceDefinition;
}

/** Validate and canonicalize the untyped ESM boundary before Core consumes a Plugin. */
export function validatePluginDefinition(value: unknown, manifest: PluginManifest): PluginDefinition {
  const definition = record(value, `Plugin ${manifest.id}@${manifest.version} definition`);
  if (definition.id !== manifest.id || definition.version !== manifest.version) {
    throw new Error(`Plugin entry identity does not match ${manifest.id}@${manifest.version}`);
  }
  const sourceCatalog = record(definition.services, "Plugin services");
  if (definition.validateConfig !== undefined && typeof definition.validateConfig !== "function") {
    throw new Error("Plugin validateConfig must be a function");
  }
  if (!Array.isArray(sourceCatalog.services)) throw new Error("Plugin services.services must be an array");
  const services = sourceCatalog.services.map(validateService);
  const catalog = createServiceCatalog(services);
  workloadProbeProviders(catalog);
  vdbTargetProviders(catalog);

  for (const service of services) {
    for (const [index, value] of (service.relationships ?? []).entries()) {
      const relationship = record(value, `${service.name}.relationships[${index}]`);
      if (relationship.kind !== "managed-by") {
        throw new Error(`${service.name}.relationships[${index}].kind is unsupported`);
      }
      const target = nonEmptyString(relationship.service, `${service.name}.relationships[${index}].service`);
      if (!services.some((candidate) => candidate.name === target)) {
        throw new Error(`${service.name}.relationships[${index}] references unknown Service '${target}'`);
      }
    }
    const dependencies = service.dependencies ?? [];
    const dependencyIds = new Set<string>();
    for (const dependency of dependencies) {
      const id = nonEmptyString(dependency.id, `${service.name}.dependencies.id`);
      if (dependencyIds.has(id)) {
        throw new Error(`${service.name}.dependencies contains duplicate id '${id}'`);
      }
      dependencyIds.add(id);
      const providerName = nonEmptyString(
        dependency.service,
        `${service.name}.dependencies.${id}.service`,
      );
      const provider = services.find((candidate) => candidate.name === providerName);
      if (!provider) {
        throw new Error(`${service.name}.dependencies '${id}' references unknown Service '${providerName}'`);
      }
      const storeId = nonEmptyString(
        dependency.dataSource,
        `${service.name}.dependencies.${id}.dataSource`,
      );
      const store = provider.dataSources?.find((candidate) => candidate.id === storeId);
      if (!store) {
        throw new Error(
          `${service.name}.dependencies '${id}' references unknown Store '${providerName}/${storeId}'`,
        );
      }
      if (store.kind !== "vdb" || store.backend !== "opensearch") {
        throw new Error(
          `${service.name}.dependencies '${id}' references unsupported Store '${providerName}/${storeId}'`
          + "；当前只支持 OpenSearch VDB",
        );
      }
    }

  }

  if (definition.model !== undefined || definition.tenant !== undefined) throw new Error("Unsupported Plugin bindings; Commands select Service Extensions by kind");
  if (definition.trace !== undefined) {
    const trace = record(definition.trace, "Plugin trace capability");
    record(trace.analysis, "Plugin trace.analysis");
    if (trace.source !== undefined) {
      const source = record(trace.source, "trace.source");
      const target = record(source.dataSource, "trace.source.dataSource");
      const serviceName = nonEmptyString(target.service, "trace.source.dataSource.service");
      const storeId = nonEmptyString(target.dataSource, "trace.source.dataSource.dataSource");
      const service = catalog.find(serviceName);
      if (!service) throw new Error(`trace.source.dataSource references unknown Service '${serviceName}'`);
      if (!service.dataSources?.some((store) => store.id === storeId)) {
        throw new Error(
          `trace.source.dataSource references unknown Store '${serviceName}/${storeId}'`,
        );
      }
    }
  }

  return { ...definition, services: catalog } as unknown as PluginDefinition;
}
