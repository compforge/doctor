import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import { resolveKubernetesCommandContext, type CommandContext } from "../command";
import type { Executor, KubectlOptions } from "../infra/k8s/executor";
import { terminalStdout } from "../terminal/output";
import { openPluginContext, type ManagedPluginContext } from "./context";

export interface ResolvePluginTraceIdOptions {
  bizId: string;
  namespace: string;
  kubeconfig?: string;
  context?: string;
  profileName: string;
  command: "doctor trace" | "doctor log";
  commandContext?: CommandContext;
}

export interface ResolvedPluginTraceId {
  bizId: string;
  traceId: string;
  service: string;
  resolvedAs: string;
}

/**
 * 调用 Plugin 声明的 traceId provider。Core 只注入已选 Kubernetes 环境和 Service
 * 身份；运行态定位、biz ID 解释方式与数据源访问均由 provider 持有。
 */
export async function resolvePluginTraceId(
  opts: ResolvePluginTraceIdOptions,
  plugin: PluginDefinition,
  executor: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<ResolvedPluginTraceId | undefined> {
  const providers = plugin.services.servicesWith("traceId");
  if (!providers.length) throw new Error("当前 Plugin 未声明 service.traceId capability");

  const kube: KubectlOptions & { namespace: string } = {
    namespace: opts.namespace,
    kubeconfig: opts.kubeconfig,
    context: opts.context,
  };
  const services = providers.map((provider) => provider.name);
  const failures: string[] = [];

  terminalStdout.write(`[collect] 正在通过 ${services.join(", ")} 解析 trace_id…\n`);
  for (const provider of providers) {
    let context = injectedContexts?.[provider.name];
    let managed: ManagedPluginContext | undefined;
    if (!context) {
      managed = await openPluginContext(executor, kube, {
        env: opts.profileName,
        config: opts.commandContext?.profile.pluginConfig,
        service: {
          name: provider.name,
          port: provider.capabilities.traceId.endpoint.port,
        },
        command: opts.command,
        capability: provider.capabilities.traceId,
        authorization: resolveKubernetesCommandContext(executor, opts.commandContext).access,
      });
      context = managed;
    }

    try {
      const resolution = await provider.capabilities.traceId.resolve(context, { bizId: opts.bizId });
      if (resolution?.traceId.trim()) {
        return {
          bizId: opts.bizId,
          traceId: resolution.traceId.trim(),
          service: provider.name,
          resolvedAs: resolution.resolvedAs,
        };
      }
      failures.push(`${provider.name}: 未识别 biz-id`);
    } catch (error) {
      failures.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
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

  throw new Error(`无法从 biz-id '${opts.bizId}' 解析出 trace_id：${failures.join("；")}`);
}
