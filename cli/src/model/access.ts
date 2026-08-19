import type {
  CapabilityWithAccess,
  ModelCatalog,
  ModelInference,
  ModelInferenceTarget,
  PluginDefinition,
  ServiceDefinition,
  ServiceWithCapability,
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
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";

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

function requireService<C extends "tenantDirectory" | "modelCatalog" | "inference">(
  plugin: PluginDefinition,
  name: string,
  capability: C,
): ServiceWithCapability<ServiceDefinition, C> {
  const service = plugin.services.findWith(name, capability);
  if (!service) {
    throw new Error(`Plugin '${plugin.id}' 的 Service '${name}' 未声明 ${capability} 能力`);
  }
  return service;
}

interface ModelProviders {
  directory: ServiceWithCapability<ServiceDefinition, "tenantDirectory">;
  catalog: ServiceWithCapability<ServiceDefinition, "modelCatalog">;
  inferenceService?: string;
}

interface PreparedModelDiscovery {
  access: ModelDiscoveryAccess;
  contextFor(
    service: ServiceDefinition,
    capability: CapabilityWithAccess,
    name?: string,
    port?: number,
  ): Promise<ManagedPluginContext>;
}

function resolveModelProviders(plugin: PluginDefinition): ModelProviders {
  const declaration = plugin.model;
  if (!declaration) throw new Error(`Plugin '${plugin.id}' 未提供 model capability`);
  return {
    directory: requireService(plugin, declaration.tenantDirectoryService, "tenantDirectory"),
    catalog: requireService(plugin, declaration.catalogService, "modelCatalog"),
    inferenceService: declaration.inferenceService?.trim() || undefined,
  };
}

function requireInferenceProvider(
  plugin: PluginDefinition,
  providers: ModelProviders,
): ServiceWithCapability<ServiceDefinition, "inference"> {
  if (!providers.inferenceService) {
    throw new Error(
      `Plugin '${plugin.id}' 的 model capability 未声明 inferenceService；主动模型调用需要 inference 能力`,
    );
  }
  return requireService(plugin, providers.inferenceService, "inference");
}

async function prepareModelDiscovery(
  options: OpenModelAccessOptions,
  providers: ModelProviders,
): Promise<PreparedModelDiscovery | undefined> {
  const tenantService = providers.directory;
  const catalogService = providers.catalog;
  const tenantPort = parseModelPort(
    options.tenantDirectoryPort,
    tenantService.capabilities.tenantDirectory.endpoint.port,
    "--tenant-directory-port",
  );
  const catalogPort = parseModelPort(
    options.modelCatalogPort,
    catalogService.capabilities.modelCatalog.endpoint.port,
    "--model-catalog-port",
  );
  const config = await resolveKubernetesCommandConfig(options, undefined, options.commandContext);
  if (!config) return undefined;
  const executor = createKubernetesExecutor(config);
  const authorization = resolveKubernetesCommandContext(executor, options.commandContext).access;
  await enforceKubernetesAccess(authorization, {
    command: options.command,
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析租户目录与模型目录 Service",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "选择 Service 对应的 Running Pod",
    }, {
      requirement: "required",
      rule: { verb: "create", resource: "pods/portforward" },
      purpose: "从 Doctor Host 调用模型域相关 endpoint",
    }],
  });
  const kube = {
    namespace: config.kubernetes.namespace,
    kubeconfig: config.kubernetes.kubeconfig,
    context: config.kubernetes.context,
  };
  const contexts: ManagedPluginContext[] = [];
  const contextFor = async (
    service: ServiceDefinition,
    capability: CapabilityWithAccess,
    name = service.name,
    port?: number,
  ) => {
    const context = await openPluginContext(executor, kube, {
      env: options.commandContext?.profile.name ?? config.profileName,
      config: options.commandContext?.profile.pluginConfig,
      service: { name, port },
      command: options.command,
      capability,
      authorization,
    });
    contexts.push(context);
    return context;
  };
  const dispose = async () => {
    await Promise.allSettled(contexts.reverse().map((context) => context.dispose()));
  };

  try {
    const directory = tenantService.capabilities.tenantDirectory.create(await contextFor(
      tenantService,
      tenantService.capabilities.tenantDirectory,
      options.tenantDirectoryService?.trim() || tenantService.name,
      tenantPort,
    ));
    const catalog = catalogService.capabilities.modelCatalog.create(await contextFor(
      catalogService,
      catalogService.capabilities.modelCatalog,
      options.modelCatalogService?.trim() || catalogService.name,
      catalogPort,
    ));
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
    createInference: async (target, timeoutMs) => await inference.capabilities.inference.create(
      await prepared.contextFor(
        inference,
        inference.capabilities.inference,
        inference.name,
        inference.capabilities.inference.endpoint.port,
      ),
      target,
      timeoutMs,
    ),
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
