import type { Extension, RegisteredExtension } from "./index";
import type { WorkloadInstance } from "../workload";

export const SERVICE_DOWNSTREAMS_KIND = "service.downstreams";
export interface ServiceDownstreamsInput { bizId?: string; instance?: WorkloadInstance }
/** An active dependency and its network entrypoint; never a credential-bearing URL. */
export interface ServiceDownstream {
  id: string;
  service: string;
  workload: string;
  endpoint: { host: string; port: number; tls?: boolean };
}
/** @spec Empty success means no applicable downstream; lookup/configuration failure must throw. */
export interface ServiceDownstreamsExtension extends Extension<ServiceDownstreamsInput, readonly ServiceDownstream[]> {
  kind: typeof SERVICE_DOWNSTREAMS_KIND;
}
export function requireServiceDownstreamsExtension(extension: RegisteredExtension): ServiceDownstreamsExtension {
  if (extension.kind !== SERVICE_DOWNSTREAMS_KIND) throw new Error(`Expected ${SERVICE_DOWNSTREAMS_KIND}`);
  return extension as ServiceDownstreamsExtension;
}
