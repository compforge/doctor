import { caseRunnerProvider } from "../case/extensions";
import { modelCatalogExtensions, modelInferenceExtensions } from "../model/extensions";
import { tenantDirectoryExtensions } from "./tenant-directory";
import {
  CASE_RUNNER_CREATE_KIND,
  createServiceCatalog,
  isToolchain,
  type PluginDefinition,
  type ServiceDefinition,
} from "@compforge/doctor-plugin";
import { caseSetFromRaw, validateCaseSet } from "@compforge/spec-case/model";
import type { PluginManifest } from "./manifest";
import { validateObservationSchema } from "./observation";

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

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function endpointPort(capability: Record<string, unknown>, label: string): void {
  const endpoint = record(capability.endpoint, `${label}.endpoint`);
  nonEmptyString(endpoint.host, `${label}.endpoint.host`);
  if (!Number.isInteger(endpoint.port) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65_535) {
    throw new Error(`${label}.endpoint.port must be an integer in 1..65535`);
  }
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

function nonEmptyStrings(value: unknown, label: string): void {
  for (const [index, item] of nonEmptyArray(value, label).entries()) {
    nonEmptyString(item, `${label}[${index}]`);
  }
}

function uniqueNonEmptyStrings(value: unknown, label: string): void {
  const seen = new Set<string>();
  for (const [index, item] of nonEmptyArray(value, label).entries()) {
    const text = nonEmptyString(item, `${label}[${index}]`);
    if (seen.has(text)) throw new Error(`${label} contains duplicate value '${text}'`);
    seen.add(text);
  }
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
      nonEmptyString(dependency.capability, `${service.name}.dependencies[${dependencyIndex}].capability`);
      nonEmptyString(dependency.dataSource, `${service.name}.dependencies[${dependencyIndex}].store`);
    }
  }
  const contributions = service.contributions === undefined
    ? {}
    : record(service.contributions, `Plugin Service '${String(service.name)}'.contributions`);
  if (contributions.detectors !== undefined) {
    for (const [detectorId, detector] of uniqueIdRecords(
      contributions.detectors,
      `${service.name}.contributions.detectors`,
    )) {
      if (typeof detector.detect !== "function") {
        throw new Error(`${service.name}.contributions.detectors.${detectorId}.detect must be a function`);
      }
    }
  }
  if (contributions.probes !== undefined) {
    for (const [probeId, probe] of uniqueIdRecords(
      contributions.probes,
      `${service.name}.contributions.probes`,
    )) {
      const label = `${service.name}.contributions.probes.${probeId}`;
      if (probe.kind === "kubernetes.apparmor-unconfined-admission") {
        if (probe.schemaVersion !== 1) {
          throw new Error(`${label} uses unsupported schemaVersion '${String(probe.schemaVersion)}'`);
        }
        if (probe.subject !== "workload-service-account") {
          throw new Error(`${label} uses unsupported subject '${String(probe.subject)}'`);
        }
      } else if (probe.kind === "workload") {
        if (probe.schemaVersion !== 1) {
          throw new Error(`${label} uses unsupported schemaVersion '${String(probe.schemaVersion)}'`);
        }
        const workloadName = nonEmptyString(probe.workload, `${label}.workload`);
        if (!workloadNames.has(workloadName)) {
          throw new Error(`${label} references unknown Workload '${workloadName}'`);
        }
        record(probe.access, `${label}.access`);
        if (typeof probe.probe !== "function") {
          throw new Error(`${label}.probe must be a function`);
        }
        const observation = record(probe.produces, `${label}.produces`);
        nonEmptyString(observation.kind, `${label}.produces.kind`);
        positiveInteger(observation.schemaVersion, `${label}.produces.schemaVersion`);
        validateObservationSchema(observation.schema, `${label}.produces.schema`);
      } else {
        throw new Error(`${label} uses unsupported kind '${String(probe.kind)}'`);
      }
    }
  }
  if (contributions.inspect !== undefined) {
    const inspect = record(contributions.inspect, `${service.name}.contributions.inspect`);
    if (inspect.description !== undefined) {
      nonEmptyString(inspect.description, `${service.name}.contributions.inspect.description`);
    }
    if (inspect.limitations !== undefined) {
      if (!Array.isArray(inspect.limitations)) {
        throw new Error(`${service.name}.contributions.inspect.limitations must be an array`);
      }
      inspect.limitations.forEach((item, index) =>
        nonEmptyString(item, `${service.name}.contributions.inspect.limitations[${index}]`));
    }
    uniqueNonEmptyStrings(inspect.accepts, `${service.name}.contributions.inspect.accepts`);
    uniqueNonEmptyStrings(inspect.provides, `${service.name}.contributions.inspect.provides`);
    if (inspect.expands !== undefined) {
      uniqueNonEmptyStrings(inspect.expands, `${service.name}.contributions.inspect.expands`);
    }
    if (typeof inspect.resolveTarget !== "function") {
      throw new Error(`${service.name}.contributions.inspect.resolveTarget must be a function`);
    }
    if (typeof inspect.inspect !== "function") {
      throw new Error(`${service.name}.contributions.inspect.inspect must be a function`);
    }
  }
  const capabilities = record(service.capabilities, `Plugin Service '${String(service.name)}'.capabilities`);
  if ("stores" in capabilities) throw new Error(`${service.name}.capabilities.stores is unsupported; declare dataSources`);
  if (capabilities.dataSources !== undefined) {
    const dataSources = uniqueIdRecords(capabilities.dataSources, `${service.name}.dataSources`);
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
      if (store.kind === "vdb" && resolver && (store.inspectTarget !== undefined || store.configuration !== undefined)) {
        throw new Error(`${label}.source cannot be combined with inspectTarget / configuration`);
      }
      if (store.access !== undefined) record(store.access, `${label}.access`);
    }
  }
  for (const name of ["traceId", "tenantDirectory", "modelCatalog", "inference", "mcp", "case", "metric"] as const) {
    const capability = capabilities[name];
    if (capability !== undefined) endpointPort(record(capability, `${service.name}.${name}`), `${service.name}.${name}`);
  }
  if (capabilities.overview !== undefined) {
    const label = `${service.name}.overview`;
    const overview = record(capabilities.overview, label);
    record(overview.access, `${label}.access`);
    const facets = uniqueIdRecords(overview.facets, `${label}.facets`);
    if (!facets.size) throw new Error(`${label}.facets must not be empty`);
    for (const [id, facet] of facets) {
      nonEmptyString(facet.title, `${label}.facets.${id}.title`);
      nonEmptyString(facet.description, `${label}.facets.${id}.description`);
    }
    for (const method of ["summarize", "sample"] as const) {
      if (typeof overview[method] !== "function") throw new Error(`${label}.${method} must be a function`);
    }
  }
  const serviceCase = capabilities.case;
  let caseSets = new Map<string, Record<string, unknown>>();
  if (serviceCase !== undefined) {
    const caseCapability = record(serviceCase, `${service.name}.case`);
    if (typeof caseCapability.createRunner !== "function") {
      throw new Error(`${service.name}.case.createRunner must be a function`);
    }
    if (caseCapability.requestIdentity !== undefined) {
      const identity = record(caseCapability.requestIdentity, `${service.name}.case.requestIdentity`);
      nonEmptyString(identity.directoryService, `${service.name}.case.requestIdentity.directoryService`);
      if (typeof identity.configured !== "function") {
        throw new Error(`${service.name}.case.requestIdentity.configured must be a function`);
      }
    }
    for (const [index, value] of nonEmptyArray(
      caseCapability.caseSets,
      `${service.name}.case.caseSets`,
    ).entries()) {
      const label = `${service.name}.case.caseSets[${index}]`;
      const raw = record(value, label);
      let caseSet;
      try {
        caseSet = caseSetFromRaw(raw);
        validateCaseSet(caseSet);
      } catch (error) {
        throw new Error(`${label} is not a valid canonical CaseSet: ${String(error)}`);
      }
      if (!caseSet.cases.length) throw new Error(`${label} must contain at least one Case`);
      if (caseSets.has(caseSet.caseset)) {
        throw new Error(`${service.name}.case.caseSets contains duplicate CaseSet '${caseSet.caseset}'`);
      }
      caseSets.set(caseSet.caseset, raw);
    }
  }
  const perf = capabilities.perf;
  if (perf !== undefined) {
    if (serviceCase === undefined) {
      throw new Error(`${service.name}.perf requires a case capability`);
    }
    const scenarios = uniqueIdRecords(
      record(perf, `${service.name}.perf`).scenarios,
      `${service.name}.perf.scenarios`,
    );
    for (const [scenarioId, scenario] of scenarios) {
      nonEmptyString(scenario.title, `${service.name}.perf.scenarios.${scenarioId}.title`);
      nonEmptyString(scenario.description, `${service.name}.perf.scenarios.${scenarioId}.description`);
      const caseSetId = nonEmptyString(
        scenario.caseSetId,
        `${service.name}.perf.scenarios.${scenarioId}.caseSetId`,
      );
      const caseSet = caseSets.get(caseSetId);
      if (!caseSet) {
        throw new Error(`${service.name}.perf scenario '${scenarioId}' references unknown CaseSet '${caseSetId}'`);
      }
      const availableCases = uniqueIdRecords(
        caseSet.cases,
        `${service.name}.case.caseSets.${caseSetId}.cases`,
      );
      let positiveWeight = false;
      const selections = nonEmptyArray(
        scenario.cases,
        `${service.name}.perf.scenarios.${scenarioId}.cases`,
      );
      const selected = new Set<string>();
      for (const [index, value] of selections.entries()) {
        const selection = record(value, `${service.name}.perf.scenarios.${scenarioId}.cases[${index}]`);
        const caseId = nonEmptyString(
          selection.caseId,
          `${service.name}.perf.scenarios.${scenarioId}.cases[${index}].caseId`,
        );
        if (!availableCases.has(caseId)) {
          throw new Error(`${service.name}.perf scenario '${scenarioId}' references unknown Case '${caseId}'`);
        }
        if (selected.has(caseId)) {
          throw new Error(`${service.name}.perf scenario '${scenarioId}' selects duplicate Case '${caseId}'`);
        }
        selected.add(caseId);
        const weight = selection.weight ?? 1;
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
          throw new Error(`${service.name}.perf scenario '${scenarioId}' has invalid weight for Case '${caseId}'`);
        }
        positiveWeight ||= weight > 0;
      }
      if (!positiveWeight) {
        throw new Error(`${service.name}.perf scenario '${scenarioId}' requires a positive Case weight`);
      }
      const observability = record(
        scenario.observability,
        `${service.name}.perf.scenarios.${scenarioId}.observability`,
      );
      nonEmptyStrings(observability.metricServices, `${service.name}.perf.scenarios.${scenarioId}.observability.metricServices`);
      nonEmptyStrings(observability.logServices, `${service.name}.perf.scenarios.${scenarioId}.observability.logServices`);
      nonEmptyStrings(observability.correlationKeys, `${service.name}.perf.scenarios.${scenarioId}.observability.correlationKeys`);
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
      if (dependency.capability !== "dataSources") {
        throw new Error(`${service.name}.dependencies '${id}' uses unsupported capability '${String(dependency.capability)}'`);
      }
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
      const store = provider.capabilities.dataSources?.find((candidate) => candidate.id === storeId);
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
    const hasCaseRunner = catalog.extensions(CASE_RUNNER_CREATE_KIND).some(item => item.service.name === service.name);
    const requirement = hasCaseRunner ? caseRunnerProvider(catalog, service.name).extension.requestIdentity : undefined;
    if (requirement) {
      tenantDirectoryExtensions(catalog, nonEmptyString(requirement.directoryService, `${service.name}.case.requestIdentity.directoryService`));
    }
  }

  if (definition.model !== undefined) {
    const model = record(definition.model, "Plugin model capability");
    tenantDirectoryExtensions(catalog, nonEmptyString(model.tenantDirectoryService, "model.tenantDirectoryService"));
    modelCatalogExtensions(catalog, nonEmptyString(model.catalogService, "model.catalogService"));
    if (model.inferenceService !== undefined) {
      modelInferenceExtensions(catalog, nonEmptyString(model.inferenceService, "model.inferenceService"));
    }
  }
  if (definition.tenant !== undefined) {
    const tenant = record(definition.tenant, "Plugin tenant capability");
    tenantDirectoryExtensions(catalog, nonEmptyString(tenant.directoryService, "tenant.directoryService"));
  }
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
      if (!service.capabilities.dataSources?.some((store) => store.id === storeId)) {
        throw new Error(
          `trace.source.dataSource references unknown Store '${serviceName}/${storeId}'`,
        );
      }
    }
  }

  return { ...definition, services: catalog } as unknown as PluginDefinition;
}
