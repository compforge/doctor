import type { Extension, RegisteredExtension } from "./index";
import type { ServiceEndpoint, ServiceTraceIdInput, ServiceTraceIdResolution, ServiceTraceIdResolutionResult } from "../service";

export const TRACE_RESOLVE_KIND = "trace.resolve";

export interface TraceResolveExtension extends Extension<ServiceTraceIdInput, ServiceTraceIdResolutionResult | undefined> {
  readonly kind: typeof TRACE_RESOLVE_KIND;
  readonly endpoint: ServiceEndpoint;
}

export function requireTraceResolveExtension(extension: RegisteredExtension): TraceResolveExtension {
  const value = extension as TraceResolveExtension;
  if (value.kind !== TRACE_RESOLVE_KIND || !value.endpoint || typeof value.endpoint.host !== "string"
    || !value.endpoint.host.trim() || !Number.isInteger(value.endpoint.port) || value.endpoint.port < 1 || value.endpoint.port > 65535) {
    throw new Error(`${extension.id}: invalid trace.resolve endpoint`);
  }
  return value;
}

/** Normalize one-or-many resolutions before Core attributes or combines provider results. */
export function traceResolveOutput(value: unknown): readonly ServiceTraceIdResolution[] {
  const items = value === undefined ? [] : Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.traceId !== "string" || typeof item.resolvedAs !== "string"
      || (item.sourceId !== undefined && typeof item.sourceId !== "string")) {
      throw new Error("trace.resolve returned an invalid resolution");
    }
  }
  return items;
}
