import {
  TENANT_LIST_KIND, TENANT_RESOLVE_KIND, USER_SEARCH_KIND,
  requireTenantListExtension, requireTenantResolveExtension, requireUserSearchExtension,
  tenantListOutput, tenantResolveOutput, userSearchOutput,
  type Extension, type ServiceCatalog, type ServiceDefinition, type ServiceEndpoint, type TenantDirectory,
} from "@compforge/doctor-plugin";
import { invokeExtension } from "./extension";
import type { ManagedPluginContext } from "./context";

/** Resolve each directory operation independently; discovery never invokes provider code. */
export function tenantDirectoryExtensions(catalog: ServiceCatalog, name: string) {
  const service = catalog.find(name);
  if (!service) throw new Error(`unknown Service '${name}'`);
  const find = (kind: string) => {
    const matches = catalog.extensions(kind).filter(item => item.service === service);
    if (matches.length > 1) throw new Error(`${service.name}: ambiguous ${kind} Extension`);
    return matches[0]?.extension;
  };
  const list = find(TENANT_LIST_KIND);
  const resolve = find(TENANT_RESOLVE_KIND);
  const search = find(USER_SEARCH_KIND);
  if (!list && !resolve && !search) throw new Error(`${service.name}: no tenant/user directory Extensions`);
  return {
    service,
    list: list ? requireTenantListExtension(list) : undefined,
    resolve: resolve ? requireTenantResolveExtension(resolve) : undefined,
    search: search ? requireUserSearchExtension(search) : undefined,
  };
}

export type TenantDirectoryExtensions = ReturnType<typeof tenantDirectoryExtensions>;

/**
 * @spec Each operation borrows its own access-scoped context and releases it after the result is read.
 * @why User search may need permissions that tenant-only consumers never request.
 */
export function extensionTenantDirectory(
  provider: TenantDirectoryExtensions,
  contextFor: (service: ServiceDefinition, extension: Extension<never, unknown> & { endpoint: ServiceEndpoint }) => Promise<ManagedPluginContext>,
): TenantDirectory {
  async function run<Input, Output>(extension: Extension<Input, Output> & { endpoint: ServiceEndpoint }, input: Input): Promise<Output> {
    const context = await contextFor(provider.service, extension);
    try {
      return await invokeExtension(extension, context, input);
    } finally {
      await context.dispose();
    }
  }
  const { list, resolve, search } = provider;
  const missing = (kind: string): never => { throw new Error(`${provider.service.name}: missing ${kind} Extension`); };
  return {
    listActive: async () => tenantListOutput(await run(list ?? missing(TENANT_LIST_KIND), undefined)),
    getByName: async name => tenantResolveOutput(await run(resolve ?? missing(TENANT_RESOLVE_KIND), { name })),
    ...(search ? { searchActiveUsers: async (input: Parameters<NonNullable<TenantDirectory["searchActiveUsers"]>>[0]) =>
      userSearchOutput(await run(search, input)) } : {}),
  };
}
