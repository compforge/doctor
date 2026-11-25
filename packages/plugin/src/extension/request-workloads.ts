import type { Workload } from "../workload";
import { validateExtension, type Extension, type ExtensionRegistration } from "./index";

export const REQUEST_WORKLOADS_KIND = "request.workloads";

/** A provider may contribute a complete declaration for another catalog Service. */
export interface RequestWorkloadsExtension extends Extension<{ readonly bizId: string }, readonly Workload[]> {
  readonly kind: typeof REQUEST_WORKLOADS_KIND;
}

export function requireRequestWorkloadsExtension(extension: ExtensionRegistration): RequestWorkloadsExtension {
  validateExtension(extension);
  if (extension.kind !== REQUEST_WORKLOADS_KIND) throw new Error(`Expected ${REQUEST_WORKLOADS_KIND}`);
  return extension as RequestWorkloadsExtension;
}

export function allRequestWorkloads(): RequestWorkloadsExtension {
  return {
    id: "request-workloads", kind: REQUEST_WORKLOADS_KIND, access: {},
    run: async context => ({
      data: context.target.service.workloads,
      summary: { title: "Workloads", text: "Use the Service's declared workloads", fields: [] },
    }),
  };
}
