import type { RegisteredExtension } from "./index";
import type { ServiceDefinition } from "../service";
import { FACTS_INSPECT_KIND, adaptServiceInspect } from "./facts-inspect";
import { TRACE_RESOLVE_KIND, type TraceResolveExtension } from "./trace-resolve";
import { OVERVIEW_SUMMARIZE_KIND, OVERVIEW_SAMPLE_KIND, type OverviewSummarizeExtension, type OverviewSampleExtension } from "./overview";

/** Offline view only: discovery must never resolve targets or query a provider. */
export function serviceExtensions(service: ServiceDefinition): readonly RegisteredExtension[] {
  const explicit = [...(service.extensions ?? [])];
  const add = <T extends RegisteredExtension>(extension: T) => {
    if (explicit.some(item => item.kind === extension.kind)) {
      throw new Error(`${service.name}: declare ${extension.kind} either as an Extension or a capability, not both`);
    }
    explicit.push(extension);
  };
  const trace = service.capabilities.traceId;
  if (trace) add({ id: "trace.resolve", kind: TRACE_RESOLVE_KIND, access: trace.access, endpoint: trace.endpoint,
    run: (context, input) => trace.resolve(context, input),
  } satisfies TraceResolveExtension);
  const overview = service.capabilities.overview;
  if (overview) {
    add({ id: "overview.summarize", kind: OVERVIEW_SUMMARIZE_KIND, access: overview.access, facets: overview.facets,
      run: (context, input) => overview.summarize(context, input),
    } satisfies OverviewSummarizeExtension);
    add({ id: "overview.sample", kind: OVERVIEW_SAMPLE_KIND, access: overview.access,
      run: (context, input) => overview.sample(context, input),
    } satisfies OverviewSampleExtension);
  }
  const inspect = service.contributions?.inspect;
  if (!inspect) return explicit;
  if (explicit.some(extension => extension.kind === FACTS_INSPECT_KIND)) {
    throw new Error(`${service.name}: declare facts.inspect either as an Extension or an Inspect contribution, not both`);
  }
  return [...explicit, adaptServiceInspect(inspect)];
}
