import {
  PERF_SCENARIOS_KIND, requirePerfScenariosExtension, perfScenariosOutput,
  type ServiceCatalog,
} from "@compforge/doctor-plugin";
import { invokeExtension } from "../plugin/extension";
import type { ManagedPluginContext } from "../plugin/context";

export function selectPerfProvider(catalog: ServiceCatalog, requested?: string) {
  const canonical = requested === undefined ? undefined : catalog.find(requested)?.name;
  const matches = catalog.extensions(PERF_SCENARIOS_KIND).filter(({ service }) => (
    requested === undefined || service.name === canonical
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "Ambiguous perf.scenarios Extension; use --service to select one Service"
      : `No perf.scenarios Extension${requested ? ` for Service '${requested}'` : ""}`);
  }
  const { service, extension } = matches[0]!;
  return { service, extension: requirePerfScenariosExtension(extension) };
}

/** Validate references before creating a runner or asking approval to generate load. */
export async function loadPerfScenarios(
  provider: ReturnType<typeof selectPerfProvider>,
  open: () => Promise<ManagedPluginContext> | ManagedPluginContext,
) {
  const context = await open();
  try {
    const scenarios = perfScenariosOutput((await invokeExtension(provider.extension, context, undefined)).data);
    return scenarios;
  } finally {
    await context.dispose();
  }
}
