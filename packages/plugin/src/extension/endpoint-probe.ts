import { validateWorkloadDeclaration } from "../workload";
import type { Workload, WorkloadInstance, Value } from "@compforge/harness-common";
import type { PluginContext } from "../context";
import { validateObservationDefinition, type ObservationDefinition, type ObservationValue } from "../observation";
import { validateWorkloadProbeResult, type WorkloadProbeResult } from "./workload";
import { validateExtension, type Extension, type ExtensionRegistration } from "./index";

export const ENDPOINT_PROBE_KIND = "endpoint.probe";
export interface EndpointProbeInput { readonly instance: WorkloadInstance }

/** @spec Independent Service contribution. The Plugin owns its targets; Core invokes it without matching service.endpoints. */
export interface EndpointProbeExtension<Definition extends ObservationDefinition = ObservationDefinition>
  extends Extension<EndpointProbeInput, WorkloadProbeResult<ObservationValue<Definition>>> {
  readonly kind: typeof ENDPOINT_PROBE_KIND;
  readonly workload: Workload;
  readonly produces: Definition;
}

export function defineEndpointProbeExtension<T extends Value>(extension:
  Omit<EndpointProbeExtension<ObservationDefinition<T>>, "run"> & {
    run(context: PluginContext, input: EndpointProbeInput): Promise<WorkloadProbeResult<T>>;
  }): EndpointProbeExtension<ObservationDefinition<T>> {
  return { ...extension, run: async (context, input) => {
    const result = await extension.run(context, input);
    validateWorkloadProbeResult(result);
    return { data: result, summary: result.value.summary() };
  } };
}

export function requireEndpointProbeExtension(extension: ExtensionRegistration): EndpointProbeExtension {
  validateExtension(extension);
  if (extension.kind !== ENDPOINT_PROBE_KIND) throw new Error(`Expected ${ENDPOINT_PROBE_KIND}, got ${extension.kind}`);
  const probe = extension as EndpointProbeExtension;
  validateWorkloadDeclaration(probe.workload);
  validateObservationDefinition(probe.produces, extension.id);
  return probe;
}
