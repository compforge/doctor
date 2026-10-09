import { validateOperation, type PluginOperation } from "./operation";
import { validateServiceEndpoint, type ServiceEndpoint, type ServiceCaseIdentityRequirement, type ServiceCaseProbeOptions, type ServiceCaseRunner } from "./service";
import type { CaseSupport } from "./cases";

/** @spec A Service Case source creates one runner; the consuming Command owns its execution and cleanup. */
export interface CaseRunnerFactory extends PluginOperation<ServiceCaseProbeOptions, ServiceCaseRunner> {
  readonly supports: CaseSupport;
  readonly endpoint: ServiceEndpoint;
  readonly requestIdentity?: ServiceCaseIdentityRequirement;
}

export function validateCaseRunnerFactory(value: unknown): asserts value is CaseRunnerFactory {
  validateOperation(value);
  const declared = value as CaseRunnerFactory;
  validateServiceEndpoint(declared.endpoint);
  if (typeof declared.supports !== "function") throw new Error("Case runner requires a supports predicate");
  const identity = declared.requestIdentity;
  if (identity !== undefined && (!identity || typeof identity.configured !== "function")) {
    throw new Error("Case runner: invalid requestIdentity");
  }
}

export function caseRunnerOutput(value: unknown): ServiceCaseRunner {
  const runner = value as ServiceCaseRunner | undefined;
  if (!runner || typeof runner.run !== "function" || typeof runner.classify !== "function"
    || [runner.setup, runner.deactivate, runner.cleanup].some(method => method !== undefined && typeof method !== "function")) {
    throw new Error("Case runner factory returned an invalid runner");
  }
  return runner;
}
