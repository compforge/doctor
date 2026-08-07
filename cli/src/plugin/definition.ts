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

function validateService(value: unknown, index: number): ServiceDefinition {
  const service = record(value, `Plugin Service[${index}]`);
  nonEmptyString(service.name, `Plugin Service[${index}].name`);
  if (service.toolchain !== undefined && !isToolchain(service.toolchain)) {
    throw new Error(`Plugin Service '${String(service.name)}'.toolchain is invalid`);
  }
  const capabilities = record(service.capabilities, `Plugin Service '${String(service.name)}'.capabilities`);
  for (const name of ["traceId", "tenantDirectory", "modelCatalog", "inference", "mcp"] as const) {
    const capability = capabilities[name];
    if (capability !== undefined) endpointPort(record(capability, `${service.name}.${name}`), `${service.name}.${name}`);
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
  if (definition.traceDiagnosis !== undefined) {
    const trace = record(definition.traceDiagnosis, "Plugin traceDiagnosis capability");
    if (trace.openSearchStore !== undefined) {
      const target = record(trace.openSearchStore, "traceDiagnosis.openSearchStore");
      const serviceName = nonEmptyString(target.service, "traceDiagnosis.openSearchStore.service");
      const storeId = nonEmptyString(target.store, "traceDiagnosis.openSearchStore.store");
      const service = catalog.find(serviceName);
      if (!service) throw new Error(`traceDiagnosis.openSearchStore references unknown Service '${serviceName}'`);
      if (!service.capabilities.stores?.some((store) => store.id === storeId)) {
        throw new Error(
          `traceDiagnosis.openSearchStore references unknown Store '${serviceName}/${storeId}'`,
        );
      }
    }
  }

  return { ...definition, services: catalog } as unknown as PluginDefinition;
}
