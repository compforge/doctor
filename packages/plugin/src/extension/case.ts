import type { Extension, RegisteredExtension } from "./index";
import { requireExtensionEndpoint } from "./endpoint";
import type { ServiceEndpoint, ServiceCaseIdentityRequirement, ServiceCaseProbeOptions, ServiceCaseRunner } from "../service";

export const CASE_RUNNER_CREATE_KIND = "case.runner.create";

/** Runner only creates request resources. Case assets belong to case.catalog. */
export interface CaseRunnerCreateExtension extends Extension<ServiceCaseProbeOptions, ServiceCaseRunner> {
  readonly endpoint: ServiceEndpoint;
  readonly requestIdentity?: ServiceCaseIdentityRequirement;
  readonly kind: typeof CASE_RUNNER_CREATE_KIND;
}

export function requireCaseRunnerCreateExtension(extension: RegisteredExtension): CaseRunnerCreateExtension {
  if (extension.kind !== CASE_RUNNER_CREATE_KIND) throw new Error(`Expected ${CASE_RUNNER_CREATE_KIND}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
  const declared = extension as CaseRunnerCreateExtension;
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
