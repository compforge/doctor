import { defineExecutionRecord } from "../../command/context";
import type {
  PluginContext,
  ServiceCatalog,
} from "@compforge/doctor-plugin";
import { findDataProvider } from "./extensions";
import { openPluginContext, type ManagedPluginContext } from "../../plugin/context";
import type { PreparedDataCommand } from "./context";
import type {
  SupportedDataService,
} from "./model";

export function isSupportedDataService(
  service: string,
  catalog: ServiceCatalog,
): service is SupportedDataService {
  return findDataProvider(catalog, service) !== undefined;
}

export interface ConfirmedDataServiceTarget {
  service: string;
  context?: PluginContext;
  access:
  | { status: "collected" }
  | { status: "unavailable" | "failed"; reason: string };
}

export interface DataAccessPreparation {
  confirmed: readonly ConfirmedDataServiceTarget[];
  lists: ReadonlyMap<string, ConfirmedDataServiceTarget>;
  close(): Promise<void>;
}

const accessFailures = defineExecutionRecord<ConfirmedDataServiceTarget>("data.access-failure");

/** Doctor 只注入当前环境与 Service 身份；运行态定位和数据源访问由 Plugin 持有。 */
export async function prepareDataAccess(
  dataCommand: PreparedDataCommand,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<DataAccessPreparation> {
  const { command, config, executor } = dataCommand;
  const confirmed: ConfirmedDataServiceTarget[] = [];
  const managedContexts: ManagedPluginContext[] = [];
  const lists = new Map<string, ConfirmedDataServiceTarget>();

  for (const declared of [...dataCommand.providers, ...dataCommand.listProviders ?? []]) {
    const record = (value: ConfirmedDataServiceTarget) => {
      if ("bizType" in declared.extension) lists.set(JSON.stringify([declared.name, declared.extension.id]), value);
      else confirmed.push(value);
    };
    const scope = [JSON.stringify([command.pluginIdentity, config.kube, config.profileName, config.fallbackIdentity,
      config.tenantId, declared.name, declared.extension.id])];
    const failed = command.latestRecord(accessFailures, scope);
    if (failed) { record(failed); continue; }
    const selection = { service: declared.name };
    let context = injectedContexts?.[selection.service];
    let managed: ManagedPluginContext | undefined;
    try {
      command.signal.throwIfAborted();
      if (config.tenantId && "bizType" in declared.extension && !declared.extension.supportsTenant) {
        throw new Error(`${declared.name}/${declared.extension.bizType} 不支持租户过滤`);
      }
      if (!context) {
        managed = await openPluginContext(executor, config.kube, {
          config: command.profile.pluginConfig,
          databaseIdentity: config.fallbackIdentity,
          service: declared.service,
          capability: declared.extension,
        });
        context = managed;
      }
      if (managed) managedContexts.push(managed);
      record({
        ...selection,
        context,
        access: {
          status: "collected",
        },
      });
    } catch (error) {
      await Promise.allSettled(managed ? [managed.dispose()] : []);
      const failure: ConfirmedDataServiceTarget = {
        ...selection,
        access: {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
      command.record(accessFailures, scope, failure);
      record(failure);
    }
  }

  return {
    confirmed,
    lists,
    close: async () => {
      const settled = await Promise.allSettled(managedContexts.map((context) => context.dispose()));
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
