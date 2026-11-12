import type { Value } from "@compforge/harness-common";
import type { PluginContext } from "../context";
import type { ServiceProbeInput } from "../service";
import { validateObservationDefinition, type ObservationDefinition, type ObservationValue } from "../observation";
import type { Extension, RegisteredExtension } from "./index";
import { validateProbeResult, type ProbeResult } from "./probe-result";

export const INSPECT_PROBE_KIND = "inspect.probe";

/**
 * @spec Inspect invokes each selected Service extension once after Facts settle. The provider owns targets and sampling.
 * @rule A probe need not reference a Workload; its Value and codec own data and presentation, not Core.
 * @see {@link cli/docs/extension.md}
 */
export interface InspectProbeExtension<Definition extends ObservationDefinition = ObservationDefinition>
  extends Extension<ServiceProbeInput, ProbeResult<ObservationValue<Definition>>> {
  readonly kind: typeof INSPECT_PROBE_KIND;
  readonly produces: Definition;
}

export function defineInspectProbeExtension<T extends Value>(
  extension: Omit<InspectProbeExtension<ObservationDefinition<T>>, "run"> & {
    run(context: PluginContext, input: ServiceProbeInput): Promise<ProbeResult<T>>;
  },
): InspectProbeExtension<ObservationDefinition<T>>;
export function defineInspectProbeExtension(
  extension: Omit<InspectProbeExtension, "run"> & {
    run(context: PluginContext, input: ServiceProbeInput): Promise<ProbeResult<Value>>;
  },
): InspectProbeExtension {
  return { ...extension, run: async (context, input) => {
    const result = await extension.run(context, input);
    validateProbeResult(result);
    return { data: result, summary: result.value.summary() };
  } };
}

export function requireInspectProbeExtension(extension: RegisteredExtension): InspectProbeExtension {
  if (extension.kind !== INSPECT_PROBE_KIND) throw new Error(`Expected ${INSPECT_PROBE_KIND}, got ${extension.kind}`);
  const probe = extension as InspectProbeExtension;
  validateObservationDefinition(probe.produces, extension.id);
  return probe;
}
