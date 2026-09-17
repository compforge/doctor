import type { Client } from "@compforge/harness-common";
import type { PluginDataSource, ServiceDataSource } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { resolveKubernetesCommandContext, type CommandContext } from "../command";
import type { KubernetesCommandConfig } from "../command/kubernetes-target";
import { openPluginContext } from "../plugin/context";

/** @spec Every Service source borrows a typed client from the root lifecycle under declared access. */
export async function borrowServiceClient<C extends Client>(
  command: CommandContext, collect: KubernetesCommandConfig, executor: Executor,
  service: string, capability: Pick<ServiceDataSource, "access">, source: PluginDataSource<C>,
): Promise<C> {
  const context = await openPluginContext(executor, collect.kubernetes, {
    clients: command.clients, config: command.profile.pluginConfig,
    service: command.plugin.services.find(service)!, command: "doctor · datasource",
    capability: { access: capability.access ?? {} },
    authorization: resolveKubernetesCommandContext(executor, command).access,
  });
  try { return await context.clients.get(source); }
  finally { await context.dispose(); }
}
