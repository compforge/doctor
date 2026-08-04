import type { ServiceWithCapability } from "@compforge/doctor-plugin";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { ServiceDefinition } from "@compforge/doctor-plugin";
import { createPluginContext } from "../../plugin/context";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import {
  parseModelPort,
  parseModelMaxOutputTokens,
  parseModelPerformanceRepeat,
  parseModelTimeout,
  parseModelType,
  requireInferenceModel,
  resolveModelTenant,
  selectModel,
} from "./config";
import type { CollectModelCliOptions } from "./model";
import { runModelDiagnosis } from "./runner";

export * from "./config";
export * from "./detector";
export * from "./fact/inspect";
export * from "./model";
export * from "./performance";
export * from "./probe";
export * from "./runner";

export async function runCollectModel(
  opts: CollectModelCliOptions,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
): Promise<number> {
  let type;
  let timeoutMs;
  let modelCatalogPort;
  let tenantDirectoryPort;
  let performanceRepeat;
  let maxOutputTokens;
  let tenantDirectoryService: ServiceWithCapability<ServiceDefinition, "tenantDirectory"> | undefined;
  let modelCatalogService: ServiceWithCapability<ServiceDefinition, "modelCatalog"> | undefined;
  let inferenceService: ServiceWithCapability<ServiceDefinition, "inference"> | undefined;
  try {
    const tenantCapability = plugin.tenantConfiguration;
    const modelCapability = plugin.modelDiagnosis;
    if (!tenantCapability) throw new Error(`Plugin '${plugin.id}' 未提供租户目录能力`);
    tenantDirectoryService = plugin.services.findWith(tenantCapability.directoryService, "tenantDirectory");
    if (!tenantDirectoryService) {
      throw new Error(
        `Plugin '${plugin.id}' 的 Service '${tenantCapability.directoryService}' 未声明 tenantDirectory 能力`,
      );
    }
    if (tenantDirectoryService.port === undefined) {
      throw new Error(`租户目录 Service '${tenantDirectoryService.name}' 未声明端口`);
    }
    if (!modelCapability) throw new Error(`Plugin '${plugin.id}' 未提供模型诊断能力`);
    modelCatalogService = plugin.services.findWith(modelCapability.catalogService, "modelCatalog");
    if (!modelCatalogService) {
      throw new Error(
        `Plugin '${plugin.id}' 的 Service '${modelCapability.catalogService}' 未声明 modelCatalog 能力`,
      );
    }
    if (modelCatalogService.port === undefined) {
      throw new Error(`模型目录 Service '${modelCatalogService.name}' 未声明端口`);
    }
    inferenceService = plugin.services.findWith(modelCapability.inferenceService, "inference");
    if (!inferenceService) {
      throw new Error(
        `Plugin '${plugin.id}' 的 Service '${modelCapability.inferenceService}' 未声明 inference 能力`,
      );
    }
    type = parseModelType(opts.type);
    timeoutMs = parseModelTimeout(opts.timeout);
    modelCatalogPort = parseModelPort(
      opts.modelCatalogPort,
      modelCatalogService.port,
      "--model-catalog-port",
    );
    tenantDirectoryPort = parseModelPort(
      opts.tenantDirectoryPort,
      tenantDirectoryService.port,
      "--tenant-directory-port",
    );
    performanceRepeat = parseModelPerformanceRepeat(opts.repeat);
    maxOutputTokens = parseModelMaxOutputTokens(opts.maxOutputTokens);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const collect = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!collect) return 130;
  terminalStdout.write(
    `[model] namespace: ${collect.kubernetes.namespace}（${collect.kubernetes.namespaceSource}）\n`,
  );
  const executor = createKubernetesExecutor(collect);
  await enforceKubernetesAccess(resolveKubernetesCommandContext(executor, commandContext).access, {
    command: "doctor model",
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
    namespace: collect.kubernetes.namespace,
    kubeconfig: collect.kubernetes.kubeconfig,
    context: collect.kubernetes.context,
  };
  const contexts: Array<ReturnType<typeof createPluginContext>> = [];
  const contextFor = (service: ServiceDefinition, name?: string, port?: number) => {
    const context = createPluginContext(executor, kube, {
      profileName: opts.profileName ?? opts.profile ?? "default",
      service: { name: name ?? service.name, port: port ?? service.port },
    });
    contexts.push(context);
    return context;
  };

  try {
    if (!tenantDirectoryService) throw new Error(`Plugin '${plugin.id}' 未提供租户目录能力`);
    if (!modelCatalogService || !inferenceService) {
      throw new Error(`Plugin '${plugin.id}' 未提供完整模型诊断能力`);
    }
    const directory = tenantDirectoryService.capabilities.tenantDirectory.create(
      contextFor(
        tenantDirectoryService,
        opts.tenantDirectoryService?.trim() || tenantDirectoryService.name,
        tenantDirectoryPort,
      ),
    );
    const tenant = await resolveModelTenant({
      tenantId: opts.tenantId,
      tenantName: opts.tenantName,
      directory,
    });
    if (!tenant) {
      terminalStderr.warning("[model] 已取消\n");
      return 130;
    }
    terminalStdout.write(`[model] tenant: ${tenant.name}（${tenant.id}）\n`);

    const catalog = modelCatalogService.capabilities.modelCatalog.create(
      contextFor(
        modelCatalogService,
        opts.modelCatalogService?.trim() || modelCatalogService.name,
        modelCatalogPort,
      ),
    );
    const models = await catalog.listAvailable(tenant.id, type);
    const selected = await selectModel({ models, query: opts.model });
    if (!selected) {
      terminalStderr.warning("[model] 已取消\n");
      return 130;
    }
    const model = requireInferenceModel(selected);
    terminalStdout.write(
      `[model] model: ${model.name}（type=${model.type}, provider=${model.provider}, id=${model.id}）\n`,
    );
    terminalStdout.write(`[model] inference endpoint: ${model.metaData.apiBase}\n`);

    const inference = inferenceService.capabilities.inference.create(
      contextFor(inferenceService),
      model.metaData.apiBase,
      timeoutMs,
    );
    if (opts.performance && model.type !== "llm") {
      throw new Error("--performance 当前只支持 llm 模型");
    }
    const result = await runModelDiagnosis({
      tenant,
      model,
      catalog,
      inference,
      performance: opts.performance,
      repeat: performanceRepeat,
      timeoutMs,
      maxOutputTokens,
      output: opts.output,
      profileName: opts.profileName ?? opts.profile ?? "default",
    });
    if (result.exitCode === 0 && !result.diagnosis.findings.some(
      (finding) => finding.severity === "critical",
    )) {
      terminalStdout.success("[model] 模型诊断完成，所需证据已完整取得。\n");
    }
    return result.exitCode;
  } catch (error) {
    terminalStderr.error(`[model] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await Promise.allSettled(contexts.map((context) => context.dispose()));
  }
}
