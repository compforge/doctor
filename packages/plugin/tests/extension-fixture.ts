import type {
  ExtensionContext, FactsInspectExtension, TenantDirectory, ServiceEndpoint, ModelCatalog, ModelInference,
  ModelInferenceTarget, ServiceCaseProbeOptions, ServiceCaseRunner, ServiceCaseIdentityRequirement,
  CaseRunnerCreateExtension, TraceResolveExtension, OverviewSummarizeExtension, OverviewSampleExtension,
  MetricConfiguration, ServicePerfScenario, WorkloadProbeExtension, ServiceEnvironmentProbe,
  TenantListExtension, TenantResolveExtension, UserSearchExtension, ModelQueryExtension,
  ModelBackendInspectExtension, ModelBackendValidateExtension, ModelInvokeExtension, ModelStreamExtension,
  McpConfigurationExtension, MetricConfigurationExtension, PerfScenariosExtension,
} from "../src";
import { modelBackendOutput } from "../src";
type Access = FactsInspectExtension["access"];
type Endpoint = { access: Access; endpoint: ServiceEndpoint };

// Test fixtures compose native operations; production SDK has no legacy registration adapters.
export function directoryExtensions(value: Endpoint & { create(context: ExtensionContext): TenantDirectory }) {
  return [
    {
      id: "tenant.list", kind: "tenant.list", access: value.access, endpoint: value.endpoint,
      run: async context => value.create(context).listActive()
    } satisfies TenantListExtension,
    {
      id: "tenant.resolve", kind: "tenant.resolve", access: value.access, endpoint: value.endpoint,
      run: async (context, input) => value.create(context).getByName(input.name)
    } satisfies TenantResolveExtension,
  ];
}
export function userExtension(value: Endpoint & { create(context: ExtensionContext): TenantDirectory }): UserSearchExtension {
  return {
    id: "user.search", kind: "user.search", access: value.access, endpoint: value.endpoint,
    run: async (context, input) => value.create(context).searchActiveUsers!(input)
  };
}
export function catalogExtensions(value: Endpoint & { create(context: ExtensionContext): ModelCatalog }) {
  return [
    {
      id: "model.query", kind: "model.query", access: value.access, endpoint: value.endpoint,
      run: async (context, input) => value.create(context).query(input)
    } satisfies ModelQueryExtension,
    {
      id: "model.backend.inspect", kind: "model.backend.inspect", access: value.access, endpoint: value.endpoint,
      run: async (context, input) => modelBackendOutput(await value.create(context).getBackend(input.model))
    } satisfies ModelBackendInspectExtension,
    {
      id: "model.backend.validate", kind: "model.backend.validate", access: value.access, endpoint: value.endpoint,
      run: async (context, input) => {
        const backend = await value.create(context).getBackend(input.model);
        if (!backend) throw new Error("backend unavailable");
        return backend.validate(input.timeoutMs);
      }
    } satisfies ModelBackendValidateExtension,
  ];
}
export function inferenceExtensions(value: Endpoint & {
  create(context: ExtensionContext, target: ModelInferenceTarget, timeoutMs: number): Promise<ModelInference>;
}) {
  return [
    {
      id: "model.invoke", kind: "model.invoke", access: value.access, endpoint: value.endpoint,
      run: async (context, input) => (await value.create(context, input.target, input.timeoutMs)).invoke(input.path, input.body)
    } satisfies ModelInvokeExtension,
    {
      id: "model.stream", kind: "model.stream", access: value.access, endpoint: value.endpoint,
      run: async (context, input) => (await value.create(context, input.target, input.timeoutMs)).invokeStream(input.path, input.body, input.signal)
    } satisfies ModelStreamExtension,
  ];
}
export function inspectExtension(value: Omit<FactsInspectExtension, "id" | "kind" | "run"> & {
  inspect: FactsInspectExtension["run"];
  resolveTarget?: (context: ExtensionContext) => Promise<unknown>;
}): FactsInspectExtension {
  const { inspect: run, resolveTarget: _target, ...declaration } = value;
  return { ...declaration, id: "inspect", kind: "facts.inspect", run };
}
export function caseExtension(value: Endpoint & {
  caseSets: CaseRunnerCreateExtension["caseSets"]; requestIdentity?: ServiceCaseIdentityRequirement;
  createRunner(context: ExtensionContext, input: ServiceCaseProbeOptions): Promise<ServiceCaseRunner>;
}): CaseRunnerCreateExtension {
  const { createRunner: run, ...declaration } = value;
  return { ...declaration, id: "case.runner.create", kind: "case.runner.create", run };
}
export function traceExtension(value: Endpoint & { resolve: TraceResolveExtension["run"] }): TraceResolveExtension {
  const { resolve: run, ...declaration } = value;
  return { ...declaration, id: "trace.resolve", kind: "trace.resolve", run };
}
export function mcpExtension(value: Endpoint & { loadConfiguration: McpConfigurationExtension["run"] }): McpConfigurationExtension {
  const { loadConfiguration: run, ...declaration } = value;
  return { ...declaration, id: "mcp.configuration", kind: "mcp.configuration", run };
}
export function overviewExtensions(value: {
  access: Access; facets: OverviewSummarizeExtension["facets"];
  summarize: OverviewSummarizeExtension["run"]; sample: OverviewSampleExtension["run"];
}) {
  return [
    { id: "overview.summarize", kind: "overview.summarize", access: value.access, facets: value.facets, run: value.summarize } satisfies OverviewSummarizeExtension,
    { id: "overview.sample", kind: "overview.sample", access: value.access, run: value.sample } satisfies OverviewSampleExtension,
  ];
}
export function metricExtension(value: MetricConfiguration): MetricConfigurationExtension {
  return { id: "metric.configuration", kind: "metric.configuration" as const, access: {}, run: async () => value };
}
export function perfExtension(value: { scenarios: readonly ServicePerfScenario[] }): PerfScenariosExtension {
  return { id: "perf.scenarios", kind: "perf.scenarios" as const, access: {}, run: async () => value.scenarios };
}
