import type { Extension, RegisteredExtension } from "./index";
import type { ObservationDefinition, ObservationValue } from "../observation";
import type { ServiceWorkloadProbeInput } from "../service";

export const WORKLOAD_PROBE_KIND = "workload.probe";

/** The Command schedules one invocation per discovered workload instance. */
export interface WorkloadProbeExtension<Definition extends ObservationDefinition = ObservationDefinition>
  extends Extension<ServiceWorkloadProbeInput, ObservationValue<Definition>> {
  readonly kind: typeof WORKLOAD_PROBE_KIND;
  readonly workload: string;
  readonly produces: Definition;
}

/** Preserve the schema-to-payload relationship when authoring a probe. */
export function defineWorkloadProbeExtension<const Definition extends ObservationDefinition>(
  extension: WorkloadProbeExtension<Definition>,
): WorkloadProbeExtension<Definition> {
  return extension;
}

export function requireWorkloadProbeExtension(extension: RegisteredExtension): WorkloadProbeExtension {
  if (extension.kind !== WORKLOAD_PROBE_KIND) throw new Error(`Expected ${WORKLOAD_PROBE_KIND}, got ${extension.kind}`);
  const probe = extension as WorkloadProbeExtension;
  if (typeof probe.workload !== "string" || !probe.workload.trim()) throw new Error(`${extension.id}: workload must be a non-empty name`);
  const produces = probe.produces;
  if (!produces || typeof produces.kind !== "string" || !produces.kind.trim()
    || !Number.isInteger(produces.schemaVersion) || produces.schemaVersion < 1
    || !produces.schema || typeof produces.schema !== "object" || Array.isArray(produces.schema)) {
    throw new Error(`${extension.id}: invalid Observation definition`);
  }
  return probe;
}
