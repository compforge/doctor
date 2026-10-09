import { validateCaseRef, type ServiceCaseRef } from "../cases";
import { validateExtension, type Extension, type ExtensionRegistration } from "./index";

export const HEALTH_CASE_BINDINGS_KIND = "health.case.bindings";

/** Health owns which shared Case source must be reachable from its Service's Workload. */
export interface HealthCaseBinding {
  readonly id: string;
  readonly workload: string;
  readonly producer: ServiceCaseRef;
}

export interface HealthCaseBindingsQuery { readonly tenantId?: string }
export interface HealthCaseBindingsResult { readonly bindings: readonly HealthCaseBinding[] }

/** @spec Health declares dependencies; the referenced Service owns Case definitions and runtime objects. */
export interface HealthCaseBindingsExtension extends Extension<HealthCaseBindingsQuery, HealthCaseBindingsResult> {
  readonly kind: typeof HEALTH_CASE_BINDINGS_KIND;
}

export function requireHealthCaseBindingsExtension(extension: ExtensionRegistration): HealthCaseBindingsExtension {
  validateExtension(extension);
  if (extension.kind !== HEALTH_CASE_BINDINGS_KIND) throw new Error(`Expected ${HEALTH_CASE_BINDINGS_KIND}, got ${extension.kind}`);
  return extension as HealthCaseBindingsExtension;
}

export function validateHealthCaseBindingsResult(value: HealthCaseBindingsResult): void {
  if (!value || typeof value !== "object") throw new Error("health.case.bindings must return bindings");
  validateHealthCaseBindings(value.bindings);
}

export function validateHealthCaseBindings(bindings: readonly HealthCaseBinding[]): void {
  if (!Array.isArray(bindings)) throw new Error("Case bindings must be an array");
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding.id !== "string" || !binding.id.trim()) throw new Error("Case binding id must be non-empty");
    if (typeof binding.workload !== "string" || !binding.workload.trim()) throw new Error("Case binding workload must be non-empty");
    if (ids.has(binding.id)) throw new Error(`Duplicate Case binding: ${binding.id}`);
    ids.add(binding.id);
    validateCaseRef(binding.producer);
  }
}
