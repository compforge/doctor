import type { PluginContext, ServiceCatalog } from "@compforge/doctor-plugin";
import { CommandInputError, type CommandContext } from "../../command";
import { terminalStderr } from "../../terminal/output";
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
      terminalStderr.warning("[collect] 已取消\n");
      return undefined;
    }
    return {
      command, config, selections,
      executor: injectedExecutor ?? new KubectlExecutor(config.kube),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CommandInputError(reason, { cause: error });
  }
}
