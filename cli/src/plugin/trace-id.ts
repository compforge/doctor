import type {
  PluginContext,
  PluginDefinition,
  ResolvedServiceCapabilityDependency,
  ServiceDefinition,
} from "@compforge/doctor-plugin";
import { resolveKubernetesCommandContext, type CommandContext } from "../command";
import type { Executor, KubectlOptions } from "../infra/k8s/executor";
import { terminalStdout } from "../terminal/output";
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
  ) => Promise<Readonly<Record<string, ResolvedServiceCapabilityDependency>>>;
}

export interface ResolvedPluginTraceId {
  bizId: string;
  traceId: string;
  service: string;
  resolvedAs: string;
  sourceId?: string;
}

/**
 * 调用 Plugin 声明的 traceId provider。Core 只注入已选 Kubernetes 环境和 Service
 * 身份；运行态定位、单个 biz ID 的解释方式与一对多映射均由 provider 持有，批次调度归 Core。
 */
export async function resolvePluginTraceIds(
  opts: ResolvePluginTraceIdOptions,
  plugin: PluginDefinition,
  executor: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<ResolvedPluginTraceId[]> {
  const providers = plugin.services.servicesWith("traceId");
  if (!providers.length) throw new Error("当前 Plugin 未声明 service.traceId capability");

  const kube: KubectlOptions & { namespace: string } = {
    namespace: opts.namespace,
    kubeconfig: opts.kubeconfig,
    context: opts.context,
  };
  const services = providers.map((provider) => provider.name);
  const bizIds = [...new Set([
    ...(opts.bizIds ?? []),
    ...(opts.bizId ? [opts.bizId] : []),
  ].map((item) => item.trim()).filter(Boolean))];
  if (!bizIds.length) throw new Error("traceId resolver 需要至少一个 biz-id");
  const unresolved = new Set(bizIds);
  const resolutions: ResolvedPluginTraceId[] = [];
  const failures = new Map(bizIds.map((bizId) => [bizId, [] as string[]]));

  terminalStdout.write(`[collect] 正在通过 ${services.join(", ")} 解析 trace_id…\n`);
  for (const provider of providers) {
    if (!unresolved.size) break;
    let context = injectedContexts?.[provider.name];
    let managed: ManagedPluginContext | undefined;
    if (!context) {
      let dependencies: Readonly<Record<string, ResolvedServiceCapabilityDependency>> = {};
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
        env: opts.profileName,
        config: opts.commandContext?.profile.pluginConfig,
        service: {
          name: provider.name,
        },
        endpoint: provider.capabilities.traceId.endpoint,
        command: opts.command,
        capability: provider.capabilities.traceId,
        dependencies,
        authorization: resolveKubernetesCommandContext(executor, opts.commandContext).access,
      });
      context = managed;
    }

    try {
      for (const bizId of [...unresolved]) {
        try {
          const result = await provider.capabilities.traceId.resolve(context, { bizId });
          const items = Array.isArray(result) ? result : result ? [result] : [];
          const valid = items.filter((item) => item.traceId.trim());
          if (!valid.length) {
            failures.get(bizId)!.push(`${provider.name}: 未识别 biz-id`);
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
        terminalStdout.warning(
          `[collect] ${provider.name} Plugin context 清理失败：`
          + `${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  if (unresolved.size) {
    const detail = [...unresolved].map((bizId) => (
      `${bizId}: ${failures.get(bizId)!.join("；")}`
    )).join("；");
    throw new Error(`无法从 biz-id 解析出 trace_id：${detail}`);
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
