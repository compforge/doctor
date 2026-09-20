import {
  VDB_TARGET_INSPECT_KIND, requireVdbTargetInspectExtension, vdbTargetOutput,
  type ServiceCatalog, type VdbTargetInspectExtension,
} from "@compforge/doctor-plugin";
import type { ManagedPluginContext } from "../plugin/context";
import { invokeExtension } from "../plugin/extension";

export function vdbTargetProviders(catalog: ServiceCatalog) {
  const seen = new Map<string, Set<string>>();
  return catalog.extensions(VDB_TARGET_INSPECT_KIND).map(({ service, extension }) => {
    const inspect = requireVdbTargetInspectExtension(extension);
    const source = service.dataSources?.find(item => item.id === inspect.dataSource);
    if (!source || source.kind !== "vdb") throw new Error(`${service.name}/${inspect.id}: unknown VDB dataSource '${inspect.dataSource}'`);
    if (source.source) throw new Error(`${service.name}/${inspect.dataSource}: datasource.vdb.inspect conflicts with a shared Client source`);
    const ids = seen.get(service.name) ?? new Set<string>();
    if (ids.has(inspect.dataSource)) throw new Error(`${service.name}/${inspect.dataSource}: ambiguous datasource.vdb.inspect Extension`);
    ids.add(inspect.dataSource);
    seen.set(service.name, ids);
    return { service, extension: inspect };
  });
}

export function vdbTargetProvider(catalog: ServiceCatalog, service: string, dataSource: string) {
  const canonical = catalog.find(service)?.name;
  return vdbTargetProviders(catalog).find(item => item.service.name === canonical && item.extension.dataSource === dataSource);
}

export async function inspectVdbTarget(
  extension: VdbTargetInspectExtension,
  open: () => Promise<ManagedPluginContext>,
) {
  const context = await open();
  try {
    return vdbTargetOutput(await invokeExtension(extension, context, undefined));
  } finally {
    await context.dispose();
  }
}
