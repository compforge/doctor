import { WORKLOAD_PROBE_KIND, type WorkloadProbeExtension } from "./workload";
import { CASE_RUNNER_CREATE_KIND, type CaseRunnerCreateExtension } from "./case";
import { PERF_SCENARIOS_KIND, type PerfScenariosExtension } from "./perf";
import { METRIC_CONFIGURATION_KIND, type MetricConfigurationExtension } from "./metric";
import { adaptModelExtensions } from "./model-adapters";
import { TENANT_LIST_KIND, TENANT_RESOLVE_KIND, USER_SEARCH_KIND, type TenantListExtension, type TenantResolveExtension, type UserSearchExtension } from "./tenant";
import { MCP_CONFIGURATION_KIND, type McpConfigurationExtension } from "./mcp";
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
  for (const extension of adaptModelExtensions(service)) add(extension);
  const cases = service.capabilities.case;
  if (cases) add({ id: CASE_RUNNER_CREATE_KIND, kind: CASE_RUNNER_CREATE_KIND,
    access: cases.access, endpoint: cases.endpoint, caseSets: cases.caseSets, requestIdentity: cases.requestIdentity,
    run: (context, input) => cases.createRunner(context, input),
  } satisfies CaseRunnerCreateExtension);
  const perf = service.capabilities.perf;
  if (perf) add({ id: PERF_SCENARIOS_KIND, kind: PERF_SCENARIOS_KIND, access: {},
    run: async () => perf.scenarios,
  } satisfies PerfScenariosExtension);
  const metric = service.capabilities.metric;
  if (metric) add({ id: METRIC_CONFIGURATION_KIND, kind: METRIC_CONFIGURATION_KIND, access: {},
    run: async () => metric,
  } satisfies MetricConfigurationExtension);
  const directory = service.capabilities.tenantDirectory;
  if (directory) {
    add({ id: TENANT_LIST_KIND, kind: TENANT_LIST_KIND, access: directory.access, endpoint: directory.endpoint,
      run: async context => directory.create(context).listActive(),
    } satisfies TenantListExtension);
    add({ id: TENANT_RESOLVE_KIND, kind: TENANT_RESOLVE_KIND, access: directory.access, endpoint: directory.endpoint,
      run: async (context, input) => directory.create(context).getByName(input.name),
    } satisfies TenantResolveExtension);
    // The legacy factory exposes optional user search only after context creation.
    add({ id: USER_SEARCH_KIND, kind: USER_SEARCH_KIND, access: directory.access, endpoint: directory.endpoint,
      run: async (context, input) => {
        const client = directory.create(context);
        if (!client.searchActiveUsers) throw new Error(`${service.name}: tenantDirectory does not support user.search`);
        return client.searchActiveUsers(input);
      },
    } satisfies UserSearchExtension);
  }
  const mcp = service.capabilities.mcp;
  if (mcp) add({ id: MCP_CONFIGURATION_KIND, kind: MCP_CONFIGURATION_KIND, access: mcp.access, endpoint: mcp.endpoint,
    run: (context, input) => mcp.loadConfiguration(context, input),
  } satisfies McpConfigurationExtension);
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
  const probes = service.contributions?.probes?.filter(probe => probe.kind === "workload") ?? [];
  if (probes.length && explicit.some(extension => extension.kind === WORKLOAD_PROBE_KIND)) {
    throw new Error(`${service.name}: declare workload.probe either as Extensions or Probe contributions, not both`);
  }
  // Multiple named probes of the same kind are independent operations on workload instances.
  for (const probe of probes) {
    const extension: WorkloadProbeExtension = {
      id: probe.id, kind: WORKLOAD_PROBE_KIND, workload: probe.workload, produces: probe.produces,
      access: probe.access, run: (context, input) => probe.probe(context, input),
    };
    explicit.push(extension);
  }
  const inspect = service.contributions?.inspect;
  if (!inspect) return explicit;
  if (explicit.some(extension => extension.kind === FACTS_INSPECT_KIND)) {
    throw new Error(`${service.name}: declare facts.inspect either as an Extension or an Inspect contribution, not both`);
  }
  return [...explicit, adaptServiceInspect(inspect)];
}
