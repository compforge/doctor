import { invokeExtension } from "./extension";
import { TRACE_RESOLVE_KIND, requireTraceResolveExtension, traceResolveOutput } from "@compforge/doctor-plugin";
import type {
  PluginContext,
  PluginDefinition,
  ResolvedServiceDataSourceDependency,
  ServiceDefinition,
} from "@compforge/doctor-plugin";
import { resolveKubernetesCommandContext, type CommandContext } from "../command";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";

import { useLogger } from "../terminal/log";
import { openPluginContext, type ManagedPluginContext } from "./context";

export interface ResolvePluginTraceIdOptions {
  bizIds?: readonly string[];
  /** @deprecated Use bizIds for batch collection. */
  bizId?: string;
  namespace: string;
  kubeconfig?: string;
  context?: string;
  profileName: string;
  command: "doctor trace" | "doctor log";
  commandContext?: CommandContext;
  resolveDependencies?: (
    service: ServiceDefinition,
  ) => Promise<Readonly<Record<string, ResolvedServiceDataSourceDependency>>>;
}

export interface ResolvedPluginTraceId {
  bizId: string;
  traceId: string;
  service: string;
  resolvedAs: string;
  sourceId?: string;
}

/**
 * 调用 Plugin 声明的 trace.resolve provider。Core 只注入已选 Kubernetes 环境和 Service
 * 身份；输入 ID 的类型判断、运行态定位与一对多映射均由 provider 持有，批次调度归 Core。
 */
export async function resolvePluginTraceIds(
  opts: ResolvePluginTraceIdOptions,
  plugin: PluginDefinition,
  executor: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<ResolvedPluginTraceId[]> {
  const providers = plugin.services.extensions(TRACE_RESOLVE_KIND);
  const seenProviders = new Set<string>();
  for (const { service } of providers) {
    if (seenProviders.has(service.name)) throw new Error(`${service.name}: ambiguous trace.resolve Extension`);
    seenProviders.add(service.name);
  }
  if (!providers.length) throw new Error("当前 Plugin 未声明 trace.resolve Extension");

  const kube: KubectlOptions & { namespace: string } = {
    namespace: opts.namespace,
    kubeconfig: opts.kubeconfig,
    context: opts.context,
  };
  const services = providers.map(({ service }) => service.name);
  const bizIds = [...new Set([
    ...(opts.bizIds ?? []),
    ...(opts.bizId ? [opts.bizId] : []),
  ].map((item) => item.trim()).filter(Boolean))];
  if (!bizIds.length) throw new Error("trace.resolve 需要至少一个输入 ID");
  const unresolved = new Set(bizIds);
  const resolutions: ResolvedPluginTraceId[] = [];
  const failures = new Map(bizIds.map((bizId) => [bizId, [] as string[]]));

  useLogger("collect").info(`正在通过 ${services.join(", ")} 解析 trace_id…`);
  for (const { service: provider, extension: registered } of providers) {
    const extension = requireTraceResolveExtension(registered);
    if (!unresolved.size) break;
    let context = injectedContexts?.[provider.name];
    let managed: ManagedPluginContext | undefined;
    if (!context) {
      let dependencies: Readonly<Record<string, ResolvedServiceDataSourceDependency>> = {};
      if (provider.dependencies?.length) {
        if (!opts.resolveDependencies) {
          throw new Error(`Service '${provider.name}' 声明了 capability 依赖，但 Core 未提供依赖解析器`);
        }
        dependencies = await opts.resolveDependencies(provider);
        const missing = provider.dependencies.filter((dependency) => !dependencies[dependency.id]);
        if (missing.length) {
          throw new Error(
            `Service '${provider.name}' capability 依赖未解析：${missing.map((item) => item.id).join(", ")}`,
          );
        }
      }
      managed = await openPluginContext(executor, kube, {
        config: opts.commandContext?.profile.pluginConfig,
        service: provider,
        endpoint: extension.endpoint,
        command: opts.command,
        capability: extension,
        dependencies,
        authorization: resolveKubernetesCommandContext(executor, opts.commandContext).access,
      });
      context = managed;
    }

    try {
      for (const bizId of [...unresolved]) {
        try {
          const result = (await invokeExtension(extension, context, { bizId })).data;
          const items = traceResolveOutput(result);
          const valid = items.filter((item) => item.traceId.trim());
          if (!valid.length) {
            failures.get(bizId)!.push(`${provider.name}: 未识别输入 ID`);
            continue;
          }
          for (const item of valid) {
            resolutions.push({
              bizId,
              traceId: item.traceId.trim(),
              service: provider.name,
              resolvedAs: item.resolvedAs,
              sourceId: item.sourceId?.trim() || undefined,
            });
          }
          unresolved.delete(bizId);
        } catch (error) {
          failures.get(bizId)!.push(
            `${provider.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      for (const bizId of unresolved) {
        failures.get(bizId)!.push(
          `${provider.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      try {
        await managed?.dispose();
      } catch (error) {
        useLogger("collect").warn(`${provider.name} Plugin context 清理失败：`
          + `${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (unresolved.size) {
    const detail = [...unresolved].map((bizId) => (
      `${bizId}: ${failures.get(bizId)!.join("；")}`
    )).join("；");
    if (!resolutions.length) throw new Error(`无法从输入 ID 解析出 trace_id：${detail}`);
    useLogger("collect").warn(`部分请求没有可用 trace，跳过其 Trace/Log：${detail}`);
  }
  const seen = new Set<string>();
  return resolutions.filter((item) => {
    const key = `${item.bizId}\0${item.traceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @deprecated Batch-aware commands should consume resolvePluginTraceIds. */
export async function resolvePluginTraceId(
  opts: ResolvePluginTraceIdOptions,
  plugin: PluginDefinition,
  executor: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<ResolvedPluginTraceId | undefined> {
  return (await resolvePluginTraceIds(opts, plugin, executor, injectedContexts))[0];
}
