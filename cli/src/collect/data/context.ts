import type { PluginContext, ServiceCatalog } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import { KubectlExecutor, type Executor } from "../../infra/k8s/executor";
import type { EvidenceBundle } from "../evidence";
import { resolveDataConfig } from "./config";
import type { CollectDataCliOpts, DataConfig } from "./model";

/** Config 决议后、领域资源准备前的内部结果；不形成第三种 Context。 */
export interface PreparedDataCommand {
  command: CommandContext;
  config: DataConfig;
  executor: Executor;
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
  const config = await resolveDataConfig(opts, catalog, command, injectedExecutor);
  if (!config) return undefined;
  return {
    command,
    config,
    executor: injectedExecutor ?? new KubectlExecutor(config.kube),
  };
}
