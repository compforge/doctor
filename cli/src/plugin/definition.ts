import {
  createServiceCatalog,
  isToolchain,
  type PluginDefinition,
  type ServiceCapabilityName,
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

function endpointPort(capability: Record<string, unknown>, label: string): void {
  const endpoint = record(capability.endpoint, `${label}.endpoint`);
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

interface CaseFacetVocabulary {
  values?: ReadonlySet<string>;
  open: boolean;
}

function caseFacetVocabulary(value: unknown, label: string): Map<string, CaseFacetVocabulary> {
  if (value === undefined) return new Map();
  const result = new Map<string, CaseFacetVocabulary>();
  for (const [rawName, rawSpec] of Object.entries(record(value, label))) {
    const name = nonEmptyString(rawName, `${label} key`);
    const spec = record(rawSpec, `${label}.${name}`);
    const open = spec.open ?? false;
    const ordered = spec.ordered ?? false;
    if (typeof open !== "boolean") throw new Error(`${label}.${name}.open must be a boolean`);
    if (typeof ordered !== "boolean") throw new Error(`${label}.${name}.ordered must be a boolean`);

    let values: Set<string> | undefined;
    if (spec.values !== undefined) {
      values = new Set<string>();
      for (const [index, rawValue] of nonEmptyArray(spec.values, `${label}.${name}.values`).entries()) {
        const facetValue = nonEmptyString(rawValue, `${label}.${name}.values[${index}]`);
        if (values.has(facetValue)) {
          throw new Error(`${label}.${name}.values contains duplicate value '${facetValue}'`);
        }
        values.add(facetValue);
      }
    }
    if (!values && !open) {
      throw new Error(`${label}.${name} must declare non-empty values or open: true`);
    }
    if (ordered && !values) {
      throw new Error(`${label}.${name}.ordered requires values`);
    }
    result.set(name, { values, open });
  }
  return result;
}

function validateService(value: unknown, index: number): ServiceDefinition {
  const service = record(value, `Plugin Service[${index}]`);
  nonEmptyString(service.name, `Plugin Service[${index}].name`);
  if (service.toolchain !== undefined && !isToolchain(service.toolchain)) {
    throw new Error(`Plugin Service '${String(service.name)}'.toolchain is invalid`);
  }
  const capabilities = record(service.capabilities, `Plugin Service '${String(service.name)}'.capabilities`);
  for (const name of ["traceId", "tenantDirectory", "modelCatalog", "inference", "mcp", "case"] as const) {
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
    caseSets = uniqueIdRecords(caseCapability.caseSets, `${service.name}.case.caseSets`);
    for (const [caseSetId, caseSet] of caseSets) {
      nonEmptyString(caseSet.title, `${service.name}.case.caseSets.${caseSetId}.title`);
      const facetLabel = `${service.name}.case.caseSets.${caseSetId}.facets`;
      const facets = caseFacetVocabulary(caseSet.facets, facetLabel);
      const cases = uniqueIdRecords(caseSet.cases, `${service.name}.case.caseSets.${caseSetId}.cases`);
      for (const [caseId, caseAsset] of cases) {
        record(caseAsset.input, `${service.name}.case.caseSets.${caseSetId}.cases.${caseId}.input`);
        if (caseAsset.facets !== undefined) {
          const caseFacetLabel = `${service.name}.case.caseSets.${caseSetId}.cases.${caseId}.facets`;
          for (const [rawName, rawValue] of Object.entries(record(caseAsset.facets, caseFacetLabel))) {
            const name = nonEmptyString(rawName, `${caseFacetLabel} key`);
            const facetValue = nonEmptyString(rawValue, `${caseFacetLabel}.${name}`);
            const vocabulary = facets.get(name);
            if (!vocabulary) {
              throw new Error(`${caseFacetLabel}.${name} references an undeclared facet`);
            }
            if (vocabulary.values && !vocabulary.open && !vocabulary.values.has(facetValue)) {
              throw new Error(`${caseFacetLabel}.${name} has unknown value '${facetValue}'`);
            }
          }
        }
      }
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
    requireProvider(services, model.inferenceService, "inference", "model.inferenceService");
  }
  if (definition.tenantConfiguration !== undefined) {
    const tenant = record(definition.tenantConfiguration, "Plugin tenantConfiguration capability");
    requireProvider(services, tenant.directoryService, "tenantDirectory", "tenantConfiguration.directoryService");
    const databaseService = nonEmptyString(
      tenant.databaseService,
      "tenantConfiguration.databaseService",
    );
    if (!catalog.find(databaseService)) {
      throw new Error(`tenantConfiguration.databaseService references unknown Service '${databaseService}'`);
    }
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
