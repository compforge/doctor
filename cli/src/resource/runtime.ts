import { withDeadline } from "../command/deadline";
import { recordExecutionFailure } from "../command/execution-scope";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { ResourceQuery } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import type { KubernetesCommandConfig } from "../command/kubernetes-target";
import { createHostPluginContext, openPluginContext } from "../plugin/context";
import { invokeOperation } from "../plugin/operation";
import type { ResourceProvider } from "./catalog";

/** Each observation borrows root clients but owns its cancellation deadline and access view. */
export async function observeResource(context: CommandContext, provider: ResourceProvider, query: ResourceQuery,
  target?: { executor: Executor; kube: KubernetesCommandConfig }): Promise<{
    environment: string; result: Awaited<ReturnType<typeof provider.binding.observe.run>>;
  }> {
  const operation = provider.binding.observe;
  const db = context.profile.value.db;
  let managed: ReturnType<typeof createHostPluginContext> | undefined;
  try {
    return await withDeadline(context.signal, query.timeoutMs, async signal => {
      const options = { service: provider.service, capability: operation, config: context.profile.pluginConfig,
        clients: context.clients, signal, databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined };
      managed = target ? await openPluginContext(target.executor, target.kube.kubernetes, {
        ...options, command: `doctor resource ${provider.binding.resource.id}`,
        authorization: context.kubernetes(target.executor).access,
      }) : createHostPluginContext(options);
      const result = await invokeOperation(operation, managed, query);
      return { environment: managed.target.env, result };
    });
  } finally {
    const startedAt = Date.now();
    try { await managed?.dispose(); }
    catch (error) { recordExecutionFailure(error, { phase: "cleanup", target: provider.binding.resource.id, startedAt }); }
  }
}
