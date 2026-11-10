import type { PluginContext, ServiceCatalog } from "@compforge/doctor-plugin";
import { dataListProviders, findDataProvider, type DataListProvider, type DataProvider } from "./extensions";
import { CommandInputError, type CommandContext } from "../../command";

import { useLogger } from "../../terminal/log";
import { KubectlExecutor, type Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { EvidenceBundle } from "../evidence";
import { resolveDataConfig, resolveDataServiceSelection } from "./config";
import type { CollectDataCliOpts, DataConfig, DataServiceSelection } from "./model";

/** Command-owned selection of Service declarations; acquiring their evidence remains in Execute. */
export interface PreparedDataCommand {
  command: CommandContext;
  config: DataConfig;
  selections: readonly DataServiceSelection[];
  executor: Executor;
  providers: readonly DataProvider[];
  listProviders?: readonly DataListProvider[];
}

/** Data command 的完整执行作用域；同一个对象继续交给 Capability、Inspect 与 Probe。 */
export interface DataCommandContext extends PreparedDataCommand {
  pluginContexts: Readonly<Record<string, PluginContext>>;
  bundle: EvidenceBundle;
  log: (line: string) => void;
}

/**
 * 独立执行传入本次 doctor data 的 CommandContext；collect 组合执行传入其共享实例。
 * 两种入口从这里开始使用完全相同的 Data 配置与执行链路。
 */
export async function prepareDataCommand(
  opts: CollectDataCliOpts,
  catalog: ServiceCatalog,
  command: CommandContext,
  injectedExecutor?: Executor,
): Promise<PreparedDataCommand | undefined> {
  try {
    const config = await resolveDataConfig(opts, catalog, command, injectedExecutor);
    const selections = config ? await resolveDataServiceSelection({ config, catalog }) : undefined;
    if (!config || !selections) {
      useLogger("collect").warn("已取消");
      return undefined;
    }
    const executor = injectedExecutor ?? new KubectlExecutor(config.kube);
    const providers = (config.ids.length ? selections.filter(({ service }) => findDataProvider(catalog, service)) : []).map(({ service }) => {
      const provider = findDataProvider(catalog, service);
      if (!provider) throw new Error(`Doctor 未注册 Service '${service}' 的 data.id Extension`);
      return provider;
    });
    // Providers enforce their declarations when executing; unused paths need no RBAC preflight.
    command.signal.throwIfAborted();
    return { command, config, selections: providers.map(({ name }) => ({ service: name })), executor, providers,
      listProviders: config.list ? dataListProviders(catalog, config.services).filter(provider => config.list!.bizTypes.includes(provider.extension.bizType)) : [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandInputError(reason, { cause: error });
  }
}
