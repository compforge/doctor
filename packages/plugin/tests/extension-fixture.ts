import { withSummary } from "@compforge/doctor-plugin";
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
export type DataRun<E extends { run: (...args: any[]) => Promise<{ data: unknown }> }> = (...args: Parameters<E["run"]>) => Promise<Awaited<ReturnType<E["run"]>>["data"]>;
type Access = FactsInspectExtension["access"];
type Endpoint = { access: Access; endpoint: ServiceEndpoint };

// Test fixtures compose native operations; production SDK has no legacy registration adapters.
export function directoryExtensions(value: Endpoint & { create(context: ExtensionContext): TenantDirectory }) {
  return [
    {
      id: "tenant.list", kind: "tenant.list", access: value.access, endpoint: value.endpoint,
      run: withSummary({"title":"租户列表","fields":[{"label":"租户数","path":["length"]}]}, async context => value.create(context).listActive())
    } satisfies TenantListExtension,
    {
      id: "tenant.resolve", kind: "tenant.resolve", access: value.access, endpoint: value.endpoint,
      run: withSummary({"title":"租户详情","fields":[{"label":"ID","path":["id"]},{"label":"名称","path":["name"]},{"label":"显示名称","path":["displayName"]}]}, async (context, input) => value.create(context).getByName(input.name))
    } satisfies TenantResolveExtension,
  ];
}
export function userExtension(value: Endpoint & { create(context: ExtensionContext): TenantDirectory }): UserSearchExtension {
  return {
    id: "user.search", kind: "user.search", access: value.access, endpoint: value.endpoint,
    run: withSummary({"title":"用户查询","fields":[{"label":"总数","path":["total"]},{"label":"本页用户数","path":["users","length"]}]}, async (context, input) => value.create(context).searchActiveUsers!(input))
  };
}
export function catalogExtensions(value: Endpoint & { create(context: ExtensionContext): ModelCatalog }) {
  return [
    {
      id: "model.query", kind: "model.query", access: value.access, endpoint: value.endpoint,
      run: withSummary({"title":"模型列表","fields":[{"label":"模型数","path":["length"]}]}, async (context, input) => value.create(context).query(input))
    } satisfies ModelQueryExtension,
    {
      id: "model.backend.inspect", kind: "model.backend.inspect", access: value.access, endpoint: value.endpoint,
      run: withSummary({"title":"模型后端","fields":[{"label":"类型","path":["type"]},{"label":"名称","path":["name"]}]}, async (context, input) => modelBackendOutput(await value.create(context).getBackend(input.model)))
    } satisfies ModelBackendInspectExtension,
    {
      id: "model.backend.validate", kind: "model.backend.validate", access: value.access, endpoint: value.endpoint,
      run: withSummary({"title":"模型后端校验","fields":[{"label":"HTTP 状态","path":["status"]}]}, async (context, input) => {
        const backend = await value.create(context).getBackend(input.model);
        if (!backend) throw new Error("backend unavailable");
        return backend.validate(input.timeoutMs);
      })
    } satisfies ModelBackendValidateExtension,
  ];
}
export function inferenceExtensions(value: Endpoint & {
  create(context: ExtensionContext, target: ModelInferenceTarget, timeoutMs: number): Promise<ModelInference>;
}) {
  return [
    {
      id: "model.invoke", kind: "model.invoke", access: value.access, endpoint: value.endpoint,
      run: withSummary({"title":"模型调用","fields":[{"label":"HTTP 状态","path":["status"]}]}, async (context, input) => (await value.create(context, input.target, input.timeoutMs)).invoke(input.path, input.body))
    } satisfies ModelInvokeExtension,
    {
      id: "model.stream", kind: "model.stream", access: value.access, endpoint: value.endpoint,
      run: withSummary({"title":"模型流式调用","fields":[{"label":"HTTP 状态","path":["status"]}]}, async (context, input) => (await value.create(context, input.target, input.timeoutMs)).invokeStream(input.path, input.body, input.signal))
    } satisfies ModelStreamExtension,
  ];
}
export function inspectExtension(value: Omit<FactsInspectExtension, "id" | "kind" | "run"> & {
  inspect: DataRun<FactsInspectExtension>;
  resolveTarget?: (context: ExtensionContext) => Promise<unknown>;
}): FactsInspectExtension {
  const { inspect: run, resolveTarget: _target, ...declaration } = value;
  return { ...declaration, id: "inspect", kind: "facts.inspect", run: withSummary({ title: "Fixture", fields: [] }, run) };
}
export function caseExtension(value: Endpoint & {
  caseSets: CaseRunnerCreateExtension["caseSets"]; requestIdentity?: ServiceCaseIdentityRequirement;
  createRunner(context: ExtensionContext, input: ServiceCaseProbeOptions): Promise<ServiceCaseRunner>;
}): CaseRunnerCreateExtension {
  const { createRunner: run, ...declaration } = value;
  return { ...declaration, id: "case.runner.create", kind: "case.runner.create", run: withSummary({ title: "Fixture", fields: [] }, run) };
}
export function traceExtension(value: Endpoint & { resolve: DataRun<TraceResolveExtension> }): TraceResolveExtension {
  const { resolve: run, ...declaration } = value;
  return { ...declaration, id: "trace.resolve", kind: "trace.resolve", run: withSummary({ title: "Fixture", fields: [] }, run) };
}
export function mcpExtension(value: Endpoint & { loadConfiguration: DataRun<McpConfigurationExtension> }): McpConfigurationExtension {
  const { loadConfiguration: run, ...declaration } = value;
  return { ...declaration, id: "mcp.configuration", kind: "mcp.configuration", run: withSummary({ title: "Fixture", fields: [] }, run) };
}
export function overviewExtensions(value: {
  access: Access; facets: OverviewSummarizeExtension["facets"];
  summarize: DataRun<OverviewSummarizeExtension>; sample: DataRun<OverviewSampleExtension>;
}) {
  return [
    { id: "overview.summarize", kind: "overview.summarize", access: value.access, facets: value.facets, run: withSummary({"title":"业务概览","fields":[{"label":"条目数","path":["length"]}]}, value.summarize) } satisfies OverviewSummarizeExtension,
    { id: "overview.sample", kind: "overview.sample", access: value.access, run: withSummary({"title":"业务样本","fields":[{"label":"样本数","path":["length"]}]}, value.sample) } satisfies OverviewSampleExtension,
  ];
}
export function metricExtension(value: MetricConfiguration): MetricConfigurationExtension {
  return { id: "metric.configuration", kind: "metric.configuration" as const, access: {}, run: withSummary({ title: "指标配置", fields: [] }, async () => value) };
}
export function perfExtension(value: { scenarios: readonly ServicePerfScenario[] }): PerfScenariosExtension {
  return { id: "perf.scenarios", kind: "perf.scenarios" as const, access: {}, run: withSummary({ title: "性能场景", fields: [] }, async () => value.scenarios) };
}
