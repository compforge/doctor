import type {
  ModelCatalog,
  PluginDefinition,
  ServiceDefinition,
  ServiceWithCapability,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import { openPluginContext } from "../../plugin/context";
import { normalizeServiceDataFacts } from "../../plugin/data";
import type {
  CollectTenantCliOptions,
  TenantAccess,
  TenantCapabilityCollector,
} from "./model";

function tenantDirectoryProvider(
  plugin: PluginDefinition,
): ServiceWithCapability<ServiceDefinition, "tenantDirectory"> {
  const declaration = plugin.tenant;
  if (!declaration) throw new Error(`Plugin '${plugin.id}' 未提供 tenant capability`);
  const service = plugin.services.findWith(declaration.directoryService, "tenantDirectory");
  if (!service) {
    throw new Error(
      `Plugin '${plugin.id}' 的 Service '${declaration.directoryService}' 未声明 tenantDirectory 能力`,
    );
  }
  return service;
}

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
  const directoryProvider = tenantDirectoryProvider(plugin);
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
  const directoryContext = await openPluginContext(executor, kube, {
    env: commandContext.profile.name,
    config: commandContext.profile.pluginConfig,
    databaseIdentity,
    service: {
      name: options.tenantDirectoryService?.trim() || directoryProvider.name,
      port: tenantDirectoryPort(
        options.tenantDirectoryPort,
        directoryProvider.capabilities.tenantDirectory.endpoint.port,
      ),
    },
    command: "doctor tenant",
    capability: directoryProvider.capabilities.tenantDirectory,
    authorization,
  });

  try {
    const directory = directoryProvider.capabilities.tenantDirectory.create(directoryContext);
    const capabilities: TenantCapabilityCollector[] = plugin.services
      .servicesWith("data")
      .filter((service) => service.capabilities.data.accepts.includes("tenant_id"))
      .map((service) => ({
        id: `data:${service.name}`,
        service: service.name,
        capability: "data" as const,
        query: async (identity) => {
          const capability = service.capabilities.data;
          const context = await openPluginContext(executor, kube, {
            env: commandContext.profile.name,
            config: commandContext.profile.pluginConfig,
            databaseIdentity,
            service: {
              name: service.name,
            },
            command: `doctor tenant · ${service.name} data`,
            capability,
            authorization,
          });
          try {
            const facts = normalizeServiceDataFacts({
              value: await capability.query(context, { identity, results: new Map() }),
              service: service.name,
              queryIdentity: identity,
              capability,
            });
            return facts.map((fact) => ({
              kind: "data" as const,
              fact,
              summary: capability.summarize(fact),
            }));
          } finally {
            await context.dispose();
          }
        },
      }));
    const model = plugin.model;
    if (model) {
      const service = plugin.services.findWith(model.catalogService, "modelCatalog");
      if (!service) {
        throw new Error(
          `Plugin '${plugin.id}' 的 Service '${model.catalogService}' 未声明 modelCatalog 能力`,
        );
      }
      capabilities.unshift({
        id: "models",
        service: service.name,
        capability: "modelCatalog",
        query: async (identity) => {
          const capability = service.capabilities.modelCatalog;
          const context = await openPluginContext(executor, kube, {
            env: commandContext.profile.name,
            config: commandContext.profile.pluginConfig,
            databaseIdentity,
            service: { name: service.name, port: capability.endpoint.port },
            command: "doctor tenant · model catalog",
            capability,
            authorization,
          });
          try {
            const catalog: ModelCatalog = capability.create(context);
            return [{ kind: "models", models: await catalog.query({ identity }) }];
          } finally {
            await context.dispose();
          }
        },
      });
    }
    return {
      config,
      directory,
      capabilities,
      dispose: () => directoryContext.dispose(),
    };
  } catch (error) {
    await directoryContext.dispose();
    throw error;
  }
}
