import type { ServiceCatalog } from "@compforge/doctor-plugin";

/** Tenant execution and offline discovery must agree on the accepted identity. */
export function tenantInspectServices(catalog: ServiceCatalog) {
  return catalog.servicesWithContribution("inspect")
    .filter(service => service.contributions.inspect.accepts.includes("tenant_id"));
}
