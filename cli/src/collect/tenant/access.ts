import { discoverTenantDirectory } from "../../plugin/tenant-directory";
import type {
  PluginDefinition,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { openPluginContext } from "../../plugin/context";
import type {
  CollectTenantCliOptions,
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
export async function openTenantDirectoryAccess(input: {
  options: CollectTenantCliOptions;
  plugin: PluginDefinition;
  commandContext: CommandContext;
}) {
  const { options, plugin, commandContext } = input;
  const config = await resolveKubernetesCommandConfig(options, undefined, commandContext);
  if (!config) return undefined;

  const executor = createKubernetesExecutor(config);
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
    capability: extension,
  }), { service: options.directoryProvider, commandContext });
  return { config, executor, kube, databaseIdentity, directory };
}
