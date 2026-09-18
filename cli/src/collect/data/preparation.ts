import type { DataSourceClient } from "@compforge/harness-common";
import type { JsonObject, PluginContext, ServiceCatalog } from "@compforge/doctor-plugin";
import { resolveKubernetesCommandContext } from "../../command";
import { openPluginContext, type ManagedPluginContext } from "../../plugin/context";
import { collectedFact, failedFact, unavailableFact } from "../protocol";
import type { PreparedDataCommand } from "./context";
import type { DataServiceFacts, DataServiceSelection, SupportedDataService } from "./model";

export function isSupportedDataService(service: string, catalog: ServiceCatalog): service is SupportedDataService {
  return catalog.findWithContribution(service, "inspect") !== undefined;
}

export interface ConfirmedDataServiceAccess {
  service: string;
  context?: PluginContext;
  access: DataServiceFacts["access"];
}

export interface DataAccessPreparation {
  confirmed: readonly ConfirmedDataServiceAccess[];
  dataSources(service: string): readonly JsonObject[];
  close(): Promise<void>;
}

/** Core prepares access; only actual client borrowing produces target evidence. */
export async function prepareDataAccess(
  dataCommand: PreparedDataCommand,
  selections: readonly DataServiceSelection[],
  catalog: ServiceCatalog,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<DataAccessPreparation> {
  const { command, config, executor } = dataCommand;
  const confirmed: ConfirmedDataServiceAccess[] = [];
  const managedContexts: ManagedPluginContext[] = [];
  const targets = new Map<string, Map<DataSourceClient, JsonObject>>();
  for (const { service } of selections) {
    const declared = catalog.findWithContribution(service, "inspect");
    if (!declared) {
      confirmed.push({ service, access: unavailableFact("data.service-access", "data-service-access",
        `Doctor 未注册 Service '${service}' 的 Inspect contribution`) });
      continue;
    }
    try {
      const context = injectedContexts?.[service] ?? await openPluginContext(executor, config.kube, {
        config: command.profile.pluginConfig,
        databaseIdentity: config.fallbackIdentity,
        service: declared,
        command: "doctor data",
        capability: declared.contributions.inspect,
        authorization: resolveKubernetesCommandContext(executor, command).access,
      });
      if (!injectedContexts?.[service]) managedContexts.push(context as ManagedPluginContext);
      const used = new Map<DataSourceClient, JsonObject>();
      targets.set(service, used);
      const observed: PluginContext = { ...context, clients: {
        get: async source => {
          const client = await context.clients.get(source);
          // Never persist raw targets or repeat resolution merely to describe them.
          used.set(client, client.mask());
          return client;
        },
      } };
      confirmed.push({ service, context: observed,
        access: collectedFact("data.service-access", "data-service-access", { ready: true }) });
    } catch (error) {
      command.signal.throwIfAborted();
      confirmed.push({ service, access: failedFact("data.service-access", "data-service-access",
        error instanceof Error ? error.message : String(error)) });
    }
  }
  return {
    confirmed,
    dataSources: service => [...(targets.get(service)?.values() ?? [])],
    close: async () => {
      const settled = await Promise.allSettled(managedContexts.map(context => context.dispose()));
      const failure = settled.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
