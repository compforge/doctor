import { TRACE_RANGE_KIND, requireTraceRangeExtension, traceRangeOutput } from "@compforge/doctor-plugin";
import type { PluginDefinition, ResolvedServiceDataSourceDependency, ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import { resolveKubernetesCommandContext, type CommandContext } from "../command";
import { openPluginContext } from "./context";
import type { ResolvedPluginTraceId } from "./trace-id";

export interface ResolvePluginTraceRangeOptions {
  window: { from: string; to: string };
  limit: number;
  kube: KubectlOptions & { namespace: string };
  commandContext: CommandContext;
  resolveDependencies?: (
    service: ServiceDefinition,
  ) => Promise<Readonly<Record<string, ResolvedServiceDataSourceDependency>>>;
}

/** A range provider owns business selection; Core only verifies its bounded trace IDs. */
export async function resolvePluginTraceRange(
  options: ResolvePluginTraceRangeOptions,
  plugin: PluginDefinition,
  executor: Executor,
): Promise<{ traces: ResolvedPluginTraceId[]; truncated?: { reason: string } }> {
  const providers = plugin.services.extensions(TRACE_RANGE_KIND);
  if (!providers.length) throw new Error("当前 Plugin 未声明 trace.range Extension");
  if (providers.length !== 1) throw new Error("多个 Service 声明了 trace.range；无法确定时间范围的业务来源");
  const { service, extension: registered } = providers[0]!;
  const extension = requireTraceRangeExtension(registered);
  let dependencies: Readonly<Record<string, ResolvedServiceDataSourceDependency>> = {};
  if (service.dependencies?.length) {
    if (!options.resolveDependencies) throw new Error(`${service.name} 的 capability 依赖未提供解析器`);
    dependencies = await options.resolveDependencies(service);
    const missing = service.dependencies.filter(dependency => !dependencies[dependency.id]);
    if (missing.length) throw new Error(`${service.name} capability 依赖未解析：${missing.map(item => item.id).join(", ")}`);
  }
  const context = await openPluginContext(executor, options.kube, {
    config: options.commandContext.profile.pluginConfig,
    service,
    command: "doctor trace",
    capability: extension,
    dependencies,
    authorization: resolveKubernetesCommandContext(executor, options.commandContext).access,
  });
  try {
    const output = traceRangeOutput(await extension.run(context, {
      window: options.window, limit: options.limit,
    }), options.limit);
    const traces = output.items.map(item => ({
      bizId: item.traceId.trim(),
      traceId: item.traceId.trim(),
      service: service.name,
      resolvedAs: item.resolvedAs,
      sourceId: item.sourceId?.trim() || undefined,
    }));
    return { traces, truncated: output.truncated };
  } finally {
    await context.dispose();
  }
}
