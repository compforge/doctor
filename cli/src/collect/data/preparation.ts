import type {
  PluginContext,
  ServiceCatalog,
} from "@compforge/doctor-plugin";
import type { Executor } from "../../infra/k8s/executor";
import { createPluginContext } from "../../plugin/context";
import type {
  DataConfig,
  DataServiceSelection,
  DataTargetFact,
  SupportedDataService,
} from "./model";

export function isSupportedDataService(
  service: string,
  catalog: ServiceCatalog,
): service is SupportedDataService {
  return catalog.findWith(service, "data") !== undefined;
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
  executor: Executor,
  config: DataConfig,
  selections: readonly DataServiceSelection[],
  catalog: ServiceCatalog,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<DataAccessPreparation> {
  const confirmed: ConfirmedDataServiceTarget[] = [];
  const managedContexts: Array<ReturnType<typeof createPluginContext>> = [];

  for (const selection of selections) {
    const declared = catalog.findWith(selection.service, "data");
    if (!declared) {
      confirmed.push({
        ...selection,
        targetFact: {
          status: "unavailable",
          reason: `Doctor 未注册 Service '${selection.service}' 的数据贡献能力`,
        },
      });
      continue;
    }
    let context = injectedContexts?.[selection.service];
    let managed: ReturnType<typeof createPluginContext> | undefined;
    if (!context) {
      managed = createPluginContext(executor, config.kube, {
        profileName: config.profileName,
        databaseIdentity: config.fallbackIdentity,
        service: { name: selection.service },
      });
      context = managed;
    }

    try {
      const target = await declared.capabilities.data.inspectTarget(context);
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
