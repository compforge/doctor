import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { Extension } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { openPluginContext } from "../plugin/context";
import { invokeExtension } from "../plugin/extension";
import type { OverviewProvider } from "./extensions";

/** Preserve each operation's providing Service and access, independently of its display namespace. */
export function overviewInvoker(context: CommandContext, executor: Executor, kubernetes: KubectlOptions & { namespace: string }, command: string) {
  const db = context.profile.value.db;
  return async <Input, Output>(provider: OverviewProvider, extension: Extension<Input, Output>, input: Input): Promise<Output> => {
    const managed = await openPluginContext(executor, kubernetes, {
      config: context.profile.pluginConfig,
      databaseIdentity: db?.user ? { user: db.user, password: db.password ?? "" } : undefined,
      service: extension === provider.sample ? provider.sampleService!
        : extension === provider.cost ? provider.costService! : provider.service,
      capability: extension, command, authorization: context.kubernetes(executor).access,
    });
    try { return (await invokeExtension(extension, managed, input)).data; }
    finally { await managed.dispose(); }
  };
}
