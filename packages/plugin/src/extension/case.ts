import { caseSetFromRaw, validateCaseSet } from "@compforge/spec-case/model";
import type { Extension, RegisteredExtension } from "./index";
import { requireExtensionEndpoint } from "./endpoint";
import type { ServiceCaseCapability, ServiceCaseProbeOptions, ServiceCaseRunner } from "../service";

export const CASE_RUNNER_CREATE_KIND = "case.runner.create";

/** Canonical assets and identity requirements are discoverable before creating request resources. */
export interface CaseRunnerCreateExtension extends Extension<ServiceCaseProbeOptions, ServiceCaseRunner>,
  Pick<ServiceCaseCapability, "endpoint" | "caseSets" | "requestIdentity"> {
  readonly kind: typeof CASE_RUNNER_CREATE_KIND;
}

export function requireCaseRunnerCreateExtension(extension: RegisteredExtension): CaseRunnerCreateExtension {
  if (extension.kind !== CASE_RUNNER_CREATE_KIND) throw new Error(`Expected ${CASE_RUNNER_CREATE_KIND}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
  const declared = extension as CaseRunnerCreateExtension;
  if (!Array.isArray(declared.caseSets) || !declared.caseSets.length) throw new Error(`${extension.id}: caseSets must not be empty`);
  const names = new Set<string>();
  for (const raw of declared.caseSets) {
    const cases = caseSetFromRaw(raw);
    validateCaseSet(cases);
    if (!cases.cases.length || names.has(cases.caseset)) throw new Error(`${extension.id}: empty or duplicate CaseSet '${cases.caseset}'`);
    names.add(cases.caseset);
  }
  const identity = declared.requestIdentity;
  if (identity !== undefined && (!identity || typeof identity.directoryService !== "string"
    || !identity.directoryService.trim() || typeof identity.configured !== "function")) {
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
