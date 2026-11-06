import type { KubectlOptions, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { PluginOperation, ServiceDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { openPluginContext } from "../plugin/context";
import { invokeOperation } from "../plugin/operation";

export function caseOperationInvoker(context: CommandContext, executor: Executor, kubernetes: KubectlOptions & { namespace: string }) {
  return async <I, O>(service: ServiceDefinition, operation: PluginOperation<I, O>, query: I): Promise<O> => {
    const db = context.profile.value.db;
    const managed = await openPluginContext(executor, kubernetes, {
      config: context.profile.pluginConfig, service, capability: operation, signal: context.signal, clients: context.clients,
      databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined,
    });
    try { return (await invokeOperation(operation, managed, query)).data; }
    finally { await managed.dispose(); }
  };
}

