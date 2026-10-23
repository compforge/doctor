import { ToolboxError } from "@compforge/harness-toolbox/errors";
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ToolboxError("Resource observation timed out", { kind: "timeout" })), query.timeoutMs);
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const operation = provider.binding.observe;
  const db = context.profile.value.db;
  const options = { service: provider.service, capability: operation, config: context.profile.pluginConfig,
    clients: context.clients, signal, databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined };
  let managed: ReturnType<typeof createHostPluginContext> | undefined;
  try {
    managed = target ? await openPluginContext(target.executor, target.kube.kubernetes, {
      ...options, command: `doctor resource ${provider.binding.resource.id}`,
      authorization: context.kubernetes(target.executor).access,
    }) : createHostPluginContext(options);
    signal.throwIfAborted();
    const result = await invokeOperation(operation, managed, query);
    signal.throwIfAborted();
    return { environment: managed.target.env, result };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    await managed?.dispose();
  }
}
