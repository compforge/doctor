import {
  validateExtensionResult, caseRunner, caseRunnerOutput,
  type ServiceCatalog, type CaseRunnerCreateExtension, type PluginContext, type ServiceCaseProbeOptions,
} from "@compforge/doctor-plugin";
import type { Case } from "@compforge/spec-case/model";
import type { DoctorCaseSet } from "./catalog";

export function caseRunnerProvider(catalog: ServiceCatalog, requested?: string, sourceId?: string, cases?: readonly Case[]) {
  const canonical = requested === undefined ? undefined : catalog.find(requested)?.name;
  const candidates = catalog.caseSources().filter(({ service, source }) => (
    source.runner && (requested === undefined || service.name === canonical) && (sourceId === undefined || source.id === sourceId)
      && (!cases || cases.every(item => source.runner!.supports(item)))
  ));
  if (candidates.length !== 1) {
    throw new Error(candidates.length
      ? `Ambiguous Case runner${requested ? ` for Service '${requested}'` : "; use --service"}`
      : `No Case runner${requested ? ` for Service '${requested}'` : ""}${sourceId ? ` source '${sourceId}'` : ""}`);
  }
  const { service, source } = candidates[0]!;
  return { service, source, extension: caseRunner(source) };
}

/** A selected source cannot accidentally execute another Service's catalog. Local inputs remain explicit. */
export function runnerCaseCatalog(catalog: readonly DoctorCaseSet[], provider: ReturnType<typeof caseRunnerProvider>) {
  return catalog.filter(item => item.source === "local" || (item.service === provider.service.name && item.sourceId === provider.source.id));
}

/** Select assets first so multiple sources from one Service remain independently usable. */
export function runnableCaseCatalog(catalog: readonly DoctorCaseSet[], services: ServiceCatalog, requested?: string): DoctorCaseSet[] {
  const providers = services.caseSources().filter(({ service, source }) => source.runner
    && (requested === undefined || service.name === services.find(requested)?.name));
  return catalog.flatMap(entry => {
    const owners = providers.filter(({ service, source }) => entry.source === "local"
      || (entry.service === service.name && entry.sourceId === source.id));
    const supports = (item: Case) => owners.some(owner => owner.source.runner!.supports(item));
    return entry.caseSet.cases.some(supports) ? [{ ...entry, supports }] : [];
  });
}

/** Transfer a created runner to its lifecycle owner, including when cancellation races with creation. */
export async function createCaseRunner(
  extension: CaseRunnerCreateExtension,
  context: PluginContext,
  input: ServiceCaseProbeOptions,
) {
  context.signal.throwIfAborted();
  // A post-call abort check would discard the runner before the Command can clean it up.
  const result = await extension.run(context, input);
  validateExtensionResult(result);
  return caseRunnerOutput(result.data);
}
