import type { KubectlOptions, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandInvocation, PluginOperation, ServiceDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { openPluginContext } from "./context";
import { invokeOperation } from "./operation";

export function createPluginOperationInvoker(context: CommandContext, executor: Executor, kubernetes: KubectlOptions & { namespace: string }) {
  return async <I, O>(service: ServiceDefinition, operation: PluginOperation<I, O>, query: I, command?: CommandInvocation): Promise<O> => {
    const db = context.profile.value.db;
    const managed = await openPluginContext(executor, kubernetes, {
      command, config: context.profile.pluginConfig, service, capability: operation, signal: context.signal, clients: context.clients,
      databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined,
    });
    try { return (await invokeOperation(operation, managed, query)).data; }
    finally { await managed.dispose(); }
  };
}

