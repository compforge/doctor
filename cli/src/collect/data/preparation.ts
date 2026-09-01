import type {
  PluginContext,
  ServiceCatalog,
} from "@compforge/doctor-plugin";
import { resolveKubernetesCommandContext } from "../../command";
import { openPluginContext, type ManagedPluginContext } from "../../plugin/context";
import type { PreparedDataCommand } from "./context";
import type {
  DataServiceSelection,
  DataTargetFact,
  SupportedDataService,
} from "./model";

export function isSupportedDataService(
  service: string,
  catalog: ServiceCatalog,
): service is SupportedDataService {
  return catalog.findWithContribution(service, "inspect") !== undefined;
}

export interface ConfirmedDataServiceTarget {
  service: string;
  context?: PluginContext;
  targetFact:
    | ({ status: "collected" } & DataTargetFact)
    | { status: "unavailable" | "failed"; reason: string };
}

export interface DataAccessPreparation {
  confirmed: readonly ConfirmedDataServiceTarget[];
  close(): Promise<void>;
}

/** Doctor 只注入当前环境与 Service 身份；运行态定位和数据源访问由 Plugin 持有。 */
export async function prepareDataAccess(
  dataCommand: PreparedDataCommand,
  selections: readonly DataServiceSelection[],
  catalog: ServiceCatalog,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<DataAccessPreparation> {
  const { command, config, executor } = dataCommand;
  const confirmed: ConfirmedDataServiceTarget[] = [];
  const managedContexts: ManagedPluginContext[] = [];

  for (const selection of selections) {
    const declared = catalog.findWithContribution(selection.service, "inspect");
    if (!declared) {
      confirmed.push({
        ...selection,
        targetFact: {
          status: "unavailable",
          reason: `Doctor 未注册 Service '${selection.service}' 的 Inspect contribution`,
        },
      });
      continue;
    }
    let context = injectedContexts?.[selection.service];
    let managed: ManagedPluginContext | undefined;
    if (!context) {
      managed = await openPluginContext(executor, config.kube, {
        env: config.profileName,
        config: command.profile.pluginConfig,
        databaseIdentity: config.fallbackIdentity,
        service: { name: selection.service },
        command: "doctor data",
        capability: declared.contributions.inspect,
        authorization: resolveKubernetesCommandContext(executor, command).access,
      });
      context = managed;
    }

    try {
      const target = await declared.contributions.inspect.resolveTarget(context);
      if (managed) managedContexts.push(managed);
      confirmed.push({
        ...selection,
        context,
        targetFact: {
          status: "collected",
          service: selection.service,
          ...target,
        },
      });
    } catch (error) {
      await Promise.allSettled(managed ? [managed.dispose()] : []);
      confirmed.push({
        ...selection,
        targetFact: {
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
