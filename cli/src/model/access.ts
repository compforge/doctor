import { requireModelInvokeExtension, requireModelStreamExtension } from "@compforge/doctor-plugin";
import { selectExtension } from "../plugin/select-extension";
import { modelCatalogExtensions, extensionModelCatalog, extensionModelInference } from "./extensions";
import { discoverTenantDirectory } from "../plugin/tenant-directory";
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
  /** Logical provider identity, independent of endpoint host overrides. */
  modelProvider?: string;
  inferenceProvider?: string;
  directoryProvider?: string;
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
  catalog: ReturnType<typeof modelCatalogExtensions>;
}

interface PreparedModelDiscovery {
  access: ModelDiscoveryAccess;
  contextFor(
    service: ServiceDefinition,
    capability: CapabilityWithAccess,
    endpoint?: ServiceEndpoint,
  ): Promise<ManagedPluginContext>;
}

async function resolveModelProviders(options: OpenModelAccessOptions): Promise<ModelProviders> {
  const selected = await selectExtension(options.plugin.services, "model.query", {
    service: options.modelProvider, commandContext: options.commandContext,
  });
  return { catalog: modelCatalogExtensions(options.plugin.services, selected.service.name, selected.extension.id) };
}

async function prepareModelDiscovery(
  options: OpenModelAccessOptions,
  providers: ModelProviders,
): Promise<PreparedModelDiscovery | undefined> {
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
    const managed: ManagedPluginContext = {
      ...context, dispose: async () => {
        try { await context.dispose(); } finally { contexts.delete(managed); }
      }
    };
    contexts.add(managed);
    return managed;
  };
  const dispose = async () => {
    await Promise.allSettled([...contexts].reverse().map((context) => context.dispose()));
  };

  try {
    const directory = discoverTenantDirectory(options.plugin.services, (service, extension) => openPluginContext(executor, kube, {
      config: options.commandContext?.profile.pluginConfig,
      service,
      endpoint: {
        host: options.tenantDirectoryService?.trim() || extension.endpoint.host,
        port: parseModelPort(options.tenantDirectoryPort, extension.endpoint.port, "--tenant-directory-port"),
      },
      command: options.command,
      capability: extension,
      authorization,
    }), { service: options.directoryProvider, commandContext: options.commandContext });
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
  const providers = await resolveModelProviders(options);
  return (await prepareModelDiscovery(options, providers))?.access;
}

export async function openModelAccess(options: OpenModelAccessOptions): Promise<ModelAccess | undefined> {
  const providers = await resolveModelProviders(options);
  const prepared = await prepareModelDiscovery(options, providers);
  if (!prepared) return undefined;
  return {
    ...prepared.access,
    createInference: async (target, timeoutMs) => {
      const selections = new Map<string, ReturnType<typeof selectExtension>>();
      const inference = async (kind: "model.invoke" | "model.stream") => {
        let selection = selections.get(kind);
        if (!selection) {
          selection = selectExtension(options.plugin.services, kind, {
            service: options.inferenceProvider, commandContext: options.commandContext,
          });
          selections.set(kind, selection);
        }
        const selected = await selection;
        const provider = {
          service: selected.service,
          invoke: kind === "model.invoke" ? requireModelInvokeExtension(selected.extension) : undefined,
          stream: kind === "model.stream" ? requireModelStreamExtension(selected.extension) : undefined,
        };
        return extensionModelInference(provider, target, timeoutMs,
          (service, extension) => prepared.contextFor(service, extension, extension.endpoint));
      };
      return {
        invoke: async (path, body) => (await inference("model.invoke")).invoke(path, body),
        invokeStream: async (path, body, signal) => (await inference("model.stream")).invokeStream(path, body, signal),
      };
    },
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
