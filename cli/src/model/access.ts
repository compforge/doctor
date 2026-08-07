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

export interface ModelAccess {
  config: KubernetesCommandConfig;
  directory: TenantDirectory;
  catalog: ModelCatalog;
  createInference(target: ModelInferenceTarget, timeoutMs: number): Promise<ModelInference>;
  dispose(): Promise<void>;
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

export async function openModelAccess(options: OpenModelAccessOptions): Promise<ModelAccess | undefined> {
  const declaration = options.plugin.model;
  if (!declaration) throw new Error(`Plugin '${options.plugin.id}' 未提供模型能力`);
  const tenantService = requireService(
    options.plugin,
    declaration.tenantDirectoryService,
    "tenantDirectory",
  );
  const catalogService = requireService(options.plugin, declaration.catalogService, "modelCatalog");
  const inferenceService = requireService(options.plugin, declaration.inferenceService, "inference");
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
      purpose: "解析租户目录、模型目录与推理 Service",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "选择 Service 对应的 Running Pod",
    }, {
      requirement: "required",
      rule: { verb: "create", resource: "pods/portforward" },
      purpose: "从 Doctor Host 调用租户目录、模型目录与推理 endpoint",
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
    return {
      config,
      directory,
      catalog,
      createInference: async (target, timeoutMs) => await inferenceService.capabilities.inference.create(
        await contextFor(
          inferenceService,
          inferenceService.capabilities.inference,
          inferenceService.name,
          inferenceService.capabilities.inference.endpoint.port,
        ),
        target,
        timeoutMs,
      ),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function parseModelPort(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${flag} 必须是 1..65535 的整数`);
  }
  return port;
}
