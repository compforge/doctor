import {
  createServiceCatalog,
  isToolchain,
  type PluginDefinition,
  type ServiceCapabilityName,
  type ServiceDefinition,
} from "@compforge/doctor-plugin";
import { caseSetFromRaw, validateCaseSet } from "@compforge/spec-case/model";
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
  if (!Array.isArray(service.workloads)) {
    throw new Error(`Plugin Service '${String(service.name)}'.workloads must be an array`);
  }
  const workloadNames = new Set<string>();
  for (const [workloadIndex, value] of service.workloads.entries()) {
    const workload = record(value, `${service.name}.workloads[${workloadIndex}]`);
    const name = nonEmptyString(workload.name, `${service.name}.workloads[${workloadIndex}].name`);
    if (workloadNames.has(name)) throw new Error(`${service.name}.workloads contains duplicate name '${name}'`);
    workloadNames.add(name);
    if (workload.lifecycle !== "persistent" && workload.lifecycle !== "ephemeral") {
      throw new Error(`${service.name}.workloads.${name}.lifecycle must be persistent or ephemeral`);
    }
    if (workload.container !== undefined) nonEmptyString(workload.container, `${service.name}.workloads.${name}.container`);
    const discovery = record(workload.discovery, `${service.name}.workloads.${name}.discovery`);
    if (discovery.kind === "kubernetes-service") {
      nonEmptyString(discovery.service, `${service.name}.workloads.${name}.discovery.service`);
    } else if (discovery.kind === "kubernetes-pods") {
      const labels = record(discovery.labels, `${service.name}.workloads.${name}.discovery.labels`);
      if (!Object.keys(labels).length) throw new Error(`${service.name}.workloads.${name}.discovery.labels must not be empty`);
      for (const [label, labelValue] of Object.entries(labels)) {
        nonEmptyString(label, `${service.name}.workloads.${name}.discovery.labels key`);
        nonEmptyString(labelValue, `${service.name}.workloads.${name}.discovery.labels.${label}`);
      }
    } else {
      throw new Error(`${service.name}.workloads.${name}.discovery.kind is unsupported`);
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
      nonEmptyString(dependency.store, `${service.name}.dependencies[${dependencyIndex}].store`);
    }
  }
  const capabilities = record(service.capabilities, `Plugin Service '${String(service.name)}'.capabilities`);
  if (capabilities.environmentProbes !== undefined) {
    for (const [probeId, probe] of uniqueIdRecords(
      capabilities.environmentProbes,
      `${service.name}.environmentProbes`,
    )) {
      if (probe.kind !== "kubernetes.apparmor-unconfined-admission") {
        throw new Error(`${service.name}.environmentProbes probe '${probeId}' uses unsupported kind '${String(probe.kind)}'`);
      }
      if (probe.subject !== "workload-service-account") {
        throw new Error(`${service.name}.environmentProbes probe '${probeId}' uses unsupported subject '${String(probe.subject)}'`);
      }
    }
  }
  if (capabilities.inspect !== undefined) {
    const inspect = record(capabilities.inspect, `${service.name}.inspect`);
    uniqueNonEmptyStrings(inspect.accepts, `${service.name}.inspect.accepts`);
    uniqueNonEmptyStrings(inspect.provides, `${service.name}.inspect.provides`);
    if (inspect.expands !== undefined) {
      uniqueNonEmptyStrings(inspect.expands, `${service.name}.inspect.expands`);
    }
    if (typeof inspect.resolveTarget !== "function") {
      throw new Error(`${service.name}.inspect.resolveTarget must be a function`);
    }
    if (typeof inspect.query !== "function") {
      throw new Error(`${service.name}.inspect.query must be a function`);
    }
    if (typeof inspect.detect !== "function") {
      throw new Error(`${service.name}.inspect.detect must be a function`);
    }
  }
  if (capabilities.workload !== undefined) {
    const workload = record(capabilities.workload, `${service.name}.workload`);
    for (const [probeId, probe] of uniqueIdRecords(workload.probes, `${service.name}.workload.probes`)) {
      const workloadName = nonEmptyString(probe.workload, `${service.name}.workload.probes.${probeId}.workload`);
      if (!workloadNames.has(workloadName)) {
        throw new Error(`${service.name}.workload probe '${probeId}' references unknown Workload '${workloadName}'`);
      }
      if (typeof probe.observe !== "function") {
        throw new Error(`${service.name}.workload.probes.${probeId}.observe must be a function`);
      }
      if (probe.detect !== undefined && typeof probe.detect !== "function") {
        throw new Error(`${service.name}.workload.probes.${probeId}.detect must be a function`);
      }
    }
  }
  for (const name of ["traceId", "tenantDirectory", "modelCatalog", "inference", "mcp", "case", "metric"] as const) {
    const capability = capabilities[name];
    if (capability !== undefined) endpointPort(record(capability, `${service.name}.${name}`), `${service.name}.${name}`);
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

function requireProvider(
  services: readonly ServiceDefinition[],
  serviceName: unknown,
  capability: ServiceCapabilityName,
  label: string,
): void {
  const name = nonEmptyString(serviceName, label);
  const service = services.find((candidate) => candidate.name === name);
  if (!service) throw new Error(`${label} references unknown Service '${name}'`);
  if (service.capabilities[capability] === undefined) {
    throw new Error(`${label} references Service '${name}' without ${capability} capability`);
  }
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
      if (dependency.capability !== "stores") {
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
        dependency.store,
        `${service.name}.dependencies.${id}.store`,
      );
      const store = provider.capabilities.stores?.find((candidate) => candidate.id === storeId);
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
    const requirement = service.capabilities.case?.requestIdentity;
    if (requirement) {
      requireProvider(
        services,
        requirement.directoryService,
        "tenantDirectory",
        `${service.name}.case.requestIdentity.directoryService`,
      );
    }
  }

  if (definition.model !== undefined) {
    const model = record(definition.model, "Plugin model capability");
    requireProvider(services, model.tenantDirectoryService, "tenantDirectory", "model.tenantDirectoryService");
    requireProvider(services, model.catalogService, "modelCatalog", "model.catalogService");
    if (model.inferenceService !== undefined) {
      requireProvider(services, model.inferenceService, "inference", "model.inferenceService");
    }
  }
  if (definition.tenant !== undefined) {
    const tenant = record(definition.tenant, "Plugin tenant capability");
    requireProvider(services, tenant.directoryService, "tenantDirectory", "tenant.directoryService");
  }
  if (definition.trace !== undefined) {
    const trace = record(definition.trace, "Plugin trace capability");
    record(trace.analysis, "Plugin trace.analysis");
    if (trace.source !== undefined) {
      const source = record(trace.source, "trace.source");
      const target = record(source.store, "trace.source.store");
      const serviceName = nonEmptyString(target.service, "trace.source.store.service");
      const storeId = nonEmptyString(target.store, "trace.source.store.store");
      const service = catalog.find(serviceName);
      if (!service) throw new Error(`trace.source.store references unknown Service '${serviceName}'`);
      if (!service.capabilities.stores?.some((store) => store.id === storeId)) {
        throw new Error(
          `trace.source.store references unknown Store '${serviceName}/${storeId}'`,
        );
      }
    }
  }

  return { ...definition, services: catalog } as unknown as PluginDefinition;
}
