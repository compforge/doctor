import { modelCatalogExtensions, extensionModelCatalog } from "../../model/extensions";
import { dataProviders } from "../data/extensions";
import { discoverTenantDirectory } from "../../plugin/tenant-directory";
import type {
  PluginDefinition,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import { openPluginContext } from "../../plugin/context";
import { inspectExtensionQueries, normalizeServiceInspectResult } from "../../plugin/inspect";
import type {
  CollectTenantCliOptions,
  TenantAccess,
  TenantCapabilityCollector,
} from "./model";

function tenantDirectoryPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--tenant-directory-port 必须是 1..65535 的整数");
  }
  return port;
}

/** Prepare tenant identity access; each reusable capability owns its short-lived Plugin context. */
export async function openTenantAccess(input: {
  options: CollectTenantCliOptions;
  plugin: PluginDefinition;
  commandContext: CommandContext;
}): Promise<TenantAccess | undefined> {
  const { options, plugin, commandContext } = input;
  const config = await resolveKubernetesCommandConfig(options, undefined, commandContext);
  if (!config) return undefined;

  const executor = createKubernetesExecutor(config);
  const authorization = resolveKubernetesCommandContext(executor, commandContext).access;
  const kube = {
    namespace: config.kubernetes.namespace,
    kubeconfig: config.kubernetes.kubeconfig,
    context: config.kubernetes.context,
  };
  const databaseIdentity = commandContext.profile.value.db?.user
    && commandContext.profile.value.db.password
    ? {
      user: commandContext.profile.value.db.user,
      password: commandContext.profile.value.db.password,
    }
    : undefined;
  if (options.tenantDirectoryPort !== undefined) tenantDirectoryPort(options.tenantDirectoryPort, 1);
  const directory = discoverTenantDirectory(plugin.services, (service, extension) => openPluginContext(executor, kube, {
    config: commandContext.profile.pluginConfig,
    databaseIdentity,
    service,
    endpoint: {
      host: options.tenantDirectoryService?.trim() || extension.endpoint.host,
      port: tenantDirectoryPort(options.tenantDirectoryPort, extension.endpoint.port),
    },
    command: "doctor tenant",
    capability: extension,
    authorization,
  }), { service: options.directoryProvider, commandContext });
  const capabilities: TenantCapabilityCollector[] = dataProviders(plugin.services)
    .filter(provider => provider.extension.accepts.includes("tenant_id"))
    .map(({ service, extension }) => ({
      id: `inspect:${service.name}`,
      service: service.name,
      capability: "inspect" as const,
      query: async (identity) => {
        const capability = extension;
        const context = await openPluginContext(executor, kube, {
          config: commandContext.profile.pluginConfig,
          databaseIdentity,
          service: service,
          command: `doctor tenant · ${service.name} inspect`,
          capability,
          authorization,
        });
        try {
          const budget = { maxFacts: 1_000, maxBytes: 8 * 1024 * 1024 };
          const [outcome] = await inspectExtensionQueries(capability, context, [{ identity, results: new Map(), budget }]);
          if (!outcome || outcome.status === "failed") throw new Error(outcome?.reason ?? "Missing Inspect outcome");
          const result = normalizeServiceInspectResult({
            value: outcome.result,
            service: service.name,
            queryIdentity: identity,
            capability,
            budget,
          });
          return [{ kind: "data" as const, result }];
        } finally {
          await context.dispose();
        }
      },
    }));
  for (const { service: declared, extension: query } of plugin.services.extensions("model.query")) {
    const provider = modelCatalogExtensions(plugin.services, declared.name, query.id);
    const { service } = provider;
    capabilities.unshift({
      id: `models:${service.name}/${query.id}`,
      service: service.name,
      capability: "modelCatalog",
      query: async (identity) => {
        const catalog = extensionModelCatalog(provider, (service, extension) => openPluginContext(executor, kube, {
          config: commandContext.profile.pluginConfig,
          databaseIdentity,
          service, endpoint: extension.endpoint,
          command: "doctor tenant · model catalog",
          capability: extension, authorization,
        }));
        return [{ kind: "models", models: await catalog.query({ identity }) }];
      },
    });
  }
  return {
    config,
    directory,
    capabilities,
    dispose: async () => { },
  };
}
