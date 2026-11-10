import { DATA_PAGE_KIND, requireDataPageExtension, type DataPageExtension, DATA_ID_KIND, requireDataIdExtension, type DataIdExtension, type ServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";

export interface DataProvider {
  name: string;
  service: ServiceDefinition;
  extension: DataIdExtension;
}

/** Data currently attributes one data.id producer per Service; ambiguity is never resolved by order. */
export function dataProviders(catalog: ServiceCatalog, serviceName?: string): DataProvider[] {
  const seen = new Set<string>();
  return catalog.extensions(DATA_ID_KIND).filter(item => serviceName === undefined || item.service.name === serviceName).map(({ service, extension }) => {
    if (seen.has(service.name)) throw new Error(`Data requires one data.id Extension per Service: '${service.name}'`);
    seen.add(service.name);
    return { name: service.name, service, extension: requireDataIdExtension(extension) };
  });
}

export function findDataProvider(catalog: ServiceCatalog, name: string): DataProvider | undefined {
  const canonical = catalog.find(name)?.name;
  return canonical === undefined ? undefined : dataProviders(catalog, canonical)[0];
}

export interface DataPageProvider {
  name: string;
  service: ServiceDefinition;
  extension: DataPageExtension;
}

/** Static discovery, independent of target access and database availability. */
export function dataPageProviders(catalog: ServiceCatalog, services?: readonly string[]): DataPageProvider[] {
  const selected = services ? new Set(catalog.resolveNames([...services])) : undefined;
  const seen = new Set<string>();
  return catalog.extensions(DATA_PAGE_KIND).filter(({ service }) => !selected || selected.has(service.name)).map(({ service, extension }) => {
    const list = requireDataPageExtension(extension);
    const key = JSON.stringify([service.name, list.bizType]);
    if (seen.has(key)) throw new Error(`Duplicate data.page provider: ${service.name}/${list.bizType}`);
    seen.add(key);
    return { name: service.name, service, extension: list };
  });
}

export function dataTypesHelp(catalog: ServiceCatalog, services?: readonly string[], tenantOnly = false): string {
  const providers = dataPageProviders(catalog, services).filter(provider => !tenantOnly || provider.extension.supportsTenant);
  return "\n支持的 biz-type（Service 静态声明）：\n" + (providers.length
    ? providers.map(({ name, extension }) => `  ${extension.bizType}  ${name}  ${extension.description}`).join("\n")
    : "  当前 Plugin 未注册类型查询") + "\n";
}
