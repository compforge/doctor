import { caseRunnerProvider } from "../case/extensions";
import {
  PERF_SCENARIOS_KIND, requirePerfScenariosExtension, perfScenariosOutput,
  CASE_RUNNER_CREATE_KIND, type ServiceCatalog, type CaseRunnerCreateExtension,
} from "@compforge/doctor-plugin";
import { invokeExtension } from "../plugin/extension";
import type { ManagedPluginContext } from "../plugin/context";

export function selectPerfProvider(catalog: ServiceCatalog, requested?: string) {
  const caseServices = new Set(catalog.extensions(CASE_RUNNER_CREATE_KIND).map(item => item.service.name));
  const canonical = requested === undefined ? undefined : catalog.find(requested)?.name;
  const matches = catalog.extensions(PERF_SCENARIOS_KIND).filter(({ service }) => (
    requested === undefined ? caseServices.has(service.name) : service.name === canonical
  ));
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? "Ambiguous perf.scenarios Extension; use --service to select one Service"
      : `No perf.scenarios Extension${requested ? ` for Service '${requested}'` : " with a case.runner.create Extension"}`);
  }
  const { service, extension } = matches[0]!;
  return { service, cases: caseRunnerProvider(catalog, service.name).extension, extension: requirePerfScenariosExtension(extension) };
}

/** Validate references before creating a runner or asking approval to generate load. */
export async function loadPerfScenarios(
  provider: ReturnType<typeof selectPerfProvider>,
  open: () => Promise<ManagedPluginContext> | ManagedPluginContext,
) {
  const context = await open();
  try {
    const scenarios = perfScenariosOutput(await invokeExtension(provider.extension, context, undefined));
    validateScenarioCases(scenarios, provider.cases);
    return scenarios;
  } finally {
    await context.dispose();
  }
}

function validateScenarioCases(
  scenarios: ReturnType<typeof perfScenariosOutput>,
  capability: CaseRunnerCreateExtension,
): void {
  for (const scenario of scenarios) {
    const cases = capability.caseSets.find(item => item.caseset === scenario.caseSetId);
    if (!cases) throw new Error(`Perf scenario '${scenario.id}' references unknown CaseSet '${scenario.caseSetId}'`);
    for (const selection of scenario.cases) {
      if (!cases.cases.some(item => item.id === selection.caseId)) {
        throw new Error(`Perf scenario '${scenario.id}' references unknown Case '${selection.caseId}'`);
      }
    }
  }
}
