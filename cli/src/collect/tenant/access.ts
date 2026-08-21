import type {
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
import type {
  CollectTenantCliOptions,
  TenantAccess,
  TenantContributionCollector,
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

/** Prepare tenant identity access; each contribution owns and closes its own Plugin context. */
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
    const contributions: TenantContributionCollector[] = plugin.services
      .servicesWith("tenant")
      .flatMap((service) => service.capabilities.tenant.contributions.map((contribution) => ({
        id: contribution.id,
        title: contribution.title,
        service: service.name,
        collect: async (tenantId: string) => {
          const context = await openPluginContext(executor, kube, {
            env: commandContext.profile.name,
            config: commandContext.profile.pluginConfig,
            databaseIdentity,
            service: {
              name: service.name,
              port: contribution.endpoint?.port,
            },
            command: `doctor tenant · ${contribution.title}`,
            capability: contribution,
            authorization,
          });
          try {
            return await contribution.collect(context, tenantId);
          } finally {
            await context.dispose();
          }
        },
      })));
    return {
      config,
      directory,
      contributions,
      dispose: () => directoryContext.dispose(),
    };
  } catch (error) {
    await directoryContext.dispose();
    throw error;
  }
}
