import {
  validateExtensionResult, CASE_RUNNER_CREATE_KIND, requireCaseRunnerCreateExtension, caseRunnerOutput,
  type ServiceCatalog, type CaseRunnerCreateExtension, type PluginContext, type ServiceCaseProbeOptions,
} from "@compforge/doctor-plugin";

export function caseRunnerProvider(catalog: ServiceCatalog, requested?: string) {
  const canonical = requested === undefined ? undefined : catalog.find(requested)?.name;
  const candidates = catalog.extensions(CASE_RUNNER_CREATE_KIND).filter(({ service }) => (
    requested === undefined || service.name === canonical
  ));
  if (candidates.length !== 1) {
    throw new Error(candidates.length
      ? `Ambiguous case.runner.create Extension${requested ? ` for Service '${requested}'` : "; use --service"}`
      : `No case.runner.create Extension${requested ? ` for Service '${requested}'` : ""}`);
  }
  const { service, extension } = candidates[0]!;
  return { service, extension: requireCaseRunnerCreateExtension(extension) };
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
