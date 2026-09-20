import { modelCatalogExtensions, modelInferenceExtensions, extensionModelCatalog, extensionModelInference } from "./extensions";
import { tenantDirectoryExtensions, extensionTenantDirectory, type TenantDirectoryExtensions } from "../plugin/tenant-directory";
import type {
  CapabilityWithAccess,
  ModelCatalog,
  ModelInference,
  ModelInferenceTarget,
  PluginDefinition,
  ServiceDefinition,
  ServiceEndpoint,
  TenantDirectory,
} from "@compforge/doctor-plugin";

import type { CommandContext } from "../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  type KubernetesCommandConfig,
  type KubernetesCommandInput,
} from "../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../command";
import { openPluginContext, type ManagedPluginContext } from "../plugin/context";

export interface OpenModelAccessOptions extends KubernetesCommandInput {
  command: string;
  plugin: PluginDefinition;
  commandContext?: CommandContext;
  modelCatalogService?: string;
  modelCatalogPort?: string;
  tenantDirectoryService?: string;
  tenantDirectoryPort?: string;
}

export interface ModelDiscoveryAccess {
  config: KubernetesCommandConfig;
  directory: TenantDirectory;
  catalog: ModelCatalog;
  dispose(): Promise<void>;
}

export interface ModelAccess extends ModelDiscoveryAccess {
  createInference(target: ModelInferenceTarget, timeoutMs: number): Promise<ModelInference>;
}

interface ModelProviders {
  directory: TenantDirectoryExtensions;
  catalog: ReturnType<typeof modelCatalogExtensions>;
  inferenceService?: string;
}

interface PreparedModelDiscovery {
  access: ModelDiscoveryAccess;
  contextFor(
    service: ServiceDefinition,
    capability: CapabilityWithAccess,
    endpoint?: ServiceEndpoint,
  ): Promise<ManagedPluginContext>;
}

function resolveModelProviders(plugin: PluginDefinition): ModelProviders {
  const declaration = plugin.model;
  if (!declaration) throw new Error(`Plugin '${plugin.id}' 未提供 model capability`);
  return {
    directory: tenantDirectoryExtensions(plugin.services, declaration.tenantDirectoryService),
    catalog: modelCatalogExtensions(plugin.services, declaration.catalogService),
    inferenceService: declaration.inferenceService?.trim() || undefined,
  };
}

function requireInferenceProvider(
  plugin: PluginDefinition,
  providers: ModelProviders,
) {
  if (!providers.inferenceService) {
    throw new Error(
      `Plugin '${plugin.id}' 的 model capability 未声明 inferenceService；主动模型调用需要 inference 能力`,
    );
  }
  return modelInferenceExtensions(plugin.services, providers.inferenceService);
}

async function prepareModelDiscovery(
  options: OpenModelAccessOptions,
  providers: ModelProviders,
): Promise<PreparedModelDiscovery | undefined> {
  const tenantService = providers.directory;
  const catalogService = providers.catalog;
  if (options.tenantDirectoryPort !== undefined) parseModelPort(options.tenantDirectoryPort, 1, "--tenant-directory-port");
  const catalogPort = parseModelPort(
    options.modelCatalogPort,
    catalogService.query.endpoint.port,
    "--model-catalog-port",
  );
  const config = await resolveKubernetesCommandConfig(options, undefined, options.commandContext);
  if (!config) return undefined;
  const executor = createKubernetesExecutor(config);
  const authorization = resolveKubernetesCommandContext(executor, options.commandContext).access;
  const kube = {
    namespace: config.kubernetes.namespace,
    kubeconfig: config.kubernetes.kubeconfig,
    context: config.kubernetes.context,
  };
  const contexts = new Set<ManagedPluginContext>();
  const contextFor = async (
    service: ServiceDefinition,
    capability: CapabilityWithAccess,
    endpoint?: ServiceEndpoint,
  ) => {
    // Each capability owns its access requirements, including optional port-forward access.
    const context = await openPluginContext(executor, kube, {
      config: options.commandContext?.profile.pluginConfig,
      service: service,
      endpoint,
      command: options.command,
      capability,
      authorization,
    });
    const managed: ManagedPluginContext = { ...context, dispose: async () => {
      try { await context.dispose(); } finally { contexts.delete(managed); }
    } };
    contexts.add(managed);
    return managed;
  };
  const dispose = async () => {
    await Promise.allSettled([...contexts].reverse().map((context) => context.dispose()));
  };

  try {
    const directory = extensionTenantDirectory(tenantService, (service, extension) => openPluginContext(executor, kube, {
      config: options.commandContext?.profile.pluginConfig,
      service,
      endpoint: {
        host: options.tenantDirectoryService?.trim() || extension.endpoint.host,
        port: parseModelPort(options.tenantDirectoryPort, extension.endpoint.port, "--tenant-directory-port"),
      },
      command: options.command,
      capability: extension,
      authorization,
    }));
    const catalog = extensionModelCatalog(catalogService, (service, extension) => contextFor(service, extension, {
      host: options.modelCatalogService?.trim() || extension.endpoint.host,
      port: options.modelCatalogPort === undefined ? extension.endpoint.port : catalogPort,
    }));
    const access: ModelDiscoveryAccess = {
      config,
      directory,
      catalog,
      dispose,
    };
    return { access, contextFor };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * @spec Model discovery 只打开 tenant directory 与 model catalog，不能创建 inference 流量
 * @see {@link ../../docs/commands/model-diagnosis.md}
 */
export async function openModelDiscoveryAccess(
  options: OpenModelAccessOptions,
): Promise<ModelDiscoveryAccess | undefined> {
  const providers = resolveModelProviders(options.plugin);
  return (await prepareModelDiscovery(options, providers))?.access;
}

export async function openModelAccess(options: OpenModelAccessOptions): Promise<ModelAccess | undefined> {
  const providers = resolveModelProviders(options.plugin);
  const inference = requireInferenceProvider(options.plugin, providers);
  const prepared = await prepareModelDiscovery(options, providers);
  if (!prepared) return undefined;
  return {
    ...prepared.access,
    createInference: async (target, timeoutMs) => extensionModelInference(inference, target, timeoutMs,
      (service, extension) => prepared.contextFor(service, extension, extension.endpoint)),
  };
}

function parseModelPort(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${flag} 必须是 1..65535 的整数`);
  }
  return port;
}
