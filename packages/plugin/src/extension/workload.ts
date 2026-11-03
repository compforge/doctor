import type { Extension, RegisteredExtension } from "./index";
import type { ProbeObservationDefinition, SchemaObservationDefinition, ObservationDefinition, ObservationValue } from "../observation";
import type { PluginContext } from "../context";
import type { Value } from "../value";
import type { ServiceWorkloadProbeInput } from "../service";

export const WORKLOAD_PROBE_KIND = "workload.probe";

/** The Command schedules one invocation per discovered workload instance. */
export interface WorkloadProbeExtension<Definition extends ProbeObservationDefinition = ProbeObservationDefinition>
  extends Extension<ServiceWorkloadProbeInput, ObservationValue<Definition>> {
  readonly kind: typeof WORKLOAD_PROBE_KIND;
  readonly workload: string;
  readonly produces: Definition;
}

/** Infer the Probe result from its declaration; codec producers return a Value directly. */
export function defineWorkloadProbeExtension<T extends Value>(
  extension: Omit<WorkloadProbeExtension<ObservationDefinition<T>>, "run"> & {
    run(context: PluginContext, input: ServiceWorkloadProbeInput): Promise<T>;
  },
): WorkloadProbeExtension<ObservationDefinition<T>>;
export function defineWorkloadProbeExtension<const Definition extends SchemaObservationDefinition>(
  extension: WorkloadProbeExtension<Definition>,
): WorkloadProbeExtension<Definition>;
export function defineWorkloadProbeExtension(
  extension: Omit<WorkloadProbeExtension, "run"> & {
    run(context: PluginContext, input: ServiceWorkloadProbeInput): Promise<unknown>;
  },
): WorkloadProbeExtension {
  if (!("codec" in extension.produces)) return extension as WorkloadProbeExtension;
  return { ...extension, run: async (context, input) => {
    const value = await extension.run(context, input) as Value;
    return { data: value, summary: value.summary() };
  } };
}

export function requireWorkloadProbeExtension(extension: RegisteredExtension): WorkloadProbeExtension {
  if (extension.kind !== WORKLOAD_PROBE_KIND) throw new Error(`Expected ${WORKLOAD_PROBE_KIND}, got ${extension.kind}`);
  const probe = extension as WorkloadProbeExtension;
  if (typeof probe.workload !== "string" || !probe.workload.trim()) throw new Error(`${extension.id}: workload must be a non-empty name`);
  const produces = probe.produces;
  if (!produces || typeof produces.kind !== "string" || !produces.kind.trim()
    || !Number.isInteger(produces.schemaVersion) || produces.schemaVersion < 1
    || ("codec" in produces
      ? !produces.codec || typeof produces.codec.encode !== "function" || typeof produces.codec.decode !== "function"
      : !produces.schema || typeof produces.schema !== "object" || Array.isArray(produces.schema))) {
    throw new Error(`${extension.id}: invalid Observation definition`);
  }
  return probe;
}
