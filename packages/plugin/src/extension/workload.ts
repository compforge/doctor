import type { Extension, RegisteredExtension } from "./index";
import { validateObservationDefinition, type ObservationDefinition, type ObservationValue } from "../observation";
import type { PluginContext } from "../context";
import type { Value } from "@compforge/harness-common";
import type { ServiceWorkloadProbeInput } from "../service";

export const WORKLOAD_PROBE_KIND = "workload.probe";

/** The Command schedules one invocation per discovered workload instance. */
export interface WorkloadProbeExtension<Definition extends ObservationDefinition = ObservationDefinition>
  extends Extension<ServiceWorkloadProbeInput, WorkloadProbeResult<ObservationValue<Definition>>> {
  readonly kind: typeof WORKLOAD_PROBE_KIND;
  readonly workload: string;
  /** Opt in to Health scheduling; Collect continues to use the same Probe. */
  readonly health?: "self" | "deps";
  readonly produces: Definition;
}

/** Execution belongs to the Probe; the Value codec only describes the acquired data. */
export type WorkloadProbeResult<T extends Value = Value> = { readonly value: T } & (
  | { readonly status: "ok" }
  | { readonly status: "partial" | "unavailable"; readonly reason: string }
);

export function validateWorkloadProbeResult(result: WorkloadProbeResult): void {
  if (!result || !["ok", "partial", "unavailable"].includes(result.status)
    || !result.value || typeof result.value.summary !== "function"
    || (result.status !== "ok" && (typeof result.reason !== "string" || !result.reason.trim()))) {
    throw new Error("Workload Probe requires a Value and an execution status; incomplete results require a reason");
  }
}

/** Infer the acquired Value from its declaration and retain partial data in the result. */
export function defineWorkloadProbeExtension<T extends Value>(
  extension: Omit<WorkloadProbeExtension<ObservationDefinition<T>>, "run"> & {
    run(context: PluginContext, input: ServiceWorkloadProbeInput): Promise<WorkloadProbeResult<T>>;
  },
): WorkloadProbeExtension<ObservationDefinition<T>>;
export function defineWorkloadProbeExtension(
  extension: Omit<WorkloadProbeExtension, "run"> & {
    run(context: PluginContext, input: ServiceWorkloadProbeInput): Promise<WorkloadProbeResult<Value>>;
  },
): WorkloadProbeExtension {
  return { ...extension, run: async (context, input) => {
    const result = await extension.run(context, input);
    validateWorkloadProbeResult(result);
    return { data: result, summary: result.value.summary() };
  } };
}

export function requireWorkloadProbeExtension(extension: RegisteredExtension): WorkloadProbeExtension {
  if (extension.kind !== WORKLOAD_PROBE_KIND) throw new Error(`Expected ${WORKLOAD_PROBE_KIND}, got ${extension.kind}`);
  const probe = extension as WorkloadProbeExtension;
  if (typeof probe.workload !== "string" || !probe.workload.trim()) throw new Error(`${extension.id}: workload must be a non-empty name`);
  if (probe.health !== undefined && !["self", "deps"].includes(probe.health)) throw new Error(`${extension.id}: invalid health scope`);
  validateObservationDefinition(probe.produces, extension.id);
  return probe;
}
