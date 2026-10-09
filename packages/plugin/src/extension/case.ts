import { validateExtension, type Extension, type RegisteredExtension } from "./index";
import { requireExtensionEndpoint } from "./endpoint";
import type { ServiceEndpoint, ServiceCaseIdentityRequirement, ServiceCaseProbeOptions, ServiceCaseRunner } from "../service";
import type { CaseSupport } from "../cases";

export const CASE_RUNNER_CREATE_KIND = "case.runner.create";

/** Invocation envelope for Service.cases.runner; assets and request resources have separate lifetimes. */
export interface CaseRunnerCreateExtension extends Extension<ServiceCaseProbeOptions, ServiceCaseRunner> {
  readonly supports: CaseSupport;
  readonly endpoint: ServiceEndpoint;
  readonly requestIdentity?: ServiceCaseIdentityRequirement;
  readonly kind: typeof CASE_RUNNER_CREATE_KIND;
}

export function requireCaseRunnerCreateExtension(extension: RegisteredExtension): CaseRunnerCreateExtension {
  validateExtension(extension);
  if (extension.kind !== CASE_RUNNER_CREATE_KIND) throw new Error(`Expected ${CASE_RUNNER_CREATE_KIND}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
  const declared = extension as CaseRunnerCreateExtension;
  if (typeof declared.supports !== "function") throw new Error(`${extension.id}: Case runner requires a supports predicate`);
  const identity = declared.requestIdentity;
  if (identity !== undefined && (!identity || typeof identity.configured !== "function")) {
    throw new Error(`${extension.id}: invalid Case requestIdentity`);
  }
  return declared;
}

export function caseRunnerOutput(value: unknown): ServiceCaseRunner {
  const runner = value as ServiceCaseRunner | undefined;
  if (!runner || typeof runner.run !== "function" || typeof runner.classify !== "function"
    || [runner.setup, runner.deactivate, runner.cleanup].some(method => method !== undefined && typeof method !== "function")) {
    throw new Error("case.runner.create returned an invalid runner");
  }
  return runner;
}
