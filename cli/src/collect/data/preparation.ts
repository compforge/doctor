import type {
  PluginContext,
  ServiceCatalog,
} from "@compforge/doctor-plugin";
import { findDataProvider } from "./extensions";
import { resolveKubernetesCommandContext } from "../../command";
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
  close(): Promise<void>;
}

/** Doctor 只注入当前环境与 Service 身份；运行态定位和数据源访问由 Plugin 持有。 */
export async function prepareDataAccess(
  dataCommand: PreparedDataCommand,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<DataAccessPreparation> {
  const { command, config, executor } = dataCommand;
  const confirmed: ConfirmedDataServiceTarget[] = [];
  const managedContexts: ManagedPluginContext[] = [];

  for (const declared of dataCommand.providers) {
    const selection = { service: declared.name };
    let context = injectedContexts?.[selection.service];
    let managed: ManagedPluginContext | undefined;
    try {
      command.signal.throwIfAborted();
      if (!context) {
        managed = await openPluginContext(executor, config.kube, {
          config: command.profile.pluginConfig,
          databaseIdentity: config.fallbackIdentity,
          service: declared.service,
          command: "doctor data",
          capability: declared.extension,
          authorization: resolveKubernetesCommandContext(executor, command).access,
        });
        context = managed;
      }
      if (managed) managedContexts.push(managed);
      confirmed.push({
        ...selection,
        context,
        access: {
          status: "collected",
        },
      });
    } catch (error) {
      await Promise.allSettled(managed ? [managed.dispose()] : []);
      confirmed.push({
        ...selection,
        access: {
          status: "failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return {
    confirmed,
    close: async () => {
      const settled = await Promise.allSettled(managedContexts.map((context) => context.dispose()));
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
