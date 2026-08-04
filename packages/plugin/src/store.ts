import type { ServiceCatalog } from "./catalog";
import type {
  ServiceDefinition,
  ServiceStoreCapability,
  ServiceStoreKind,
} from "./service";

export function serviceStores(
  catalog: ServiceCatalog,
  service: string,
  kind?: ServiceStoreKind,
): readonly ServiceStoreCapability[] {
  const stores = catalog.findWith(service, "stores")?.capabilities.stores ?? [];
  return kind ? stores.filter((store) => store.kind === kind) : stores;
}

export function findServiceStore(
  catalog: ServiceCatalog,
  service: string,
  storeId: string,
): ServiceStoreCapability | undefined {
  return serviceStores(catalog, service).find((store) => store.id === storeId);
}

export function servicesWithStore<T extends ServiceDefinition>(
  catalog: ServiceCatalog<T>,
  kind?: ServiceStoreKind,
): T[] {
  return catalog.servicesWith("stores").filter((service) =>
    service.capabilities.stores.some((store) => !kind || store.kind === kind)
  );
}
