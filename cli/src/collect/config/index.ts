import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type {
  PluginDefinition,
  TenantConfigReader,
} from "@compforge/doctor-plugin";
import type { TenantDirectory } from "@compforge/doctor-plugin";
import { openPluginContext } from "../../plugin/context";
import { KubectlExecutor, type Executor } from "../../infra/k8s/executor";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runDiagnosis } from "../engine";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { EvidenceBundle } from "../evidence";
import { runInspects } from "../inspect-engine";
import { evaluateCollectOutcome } from "../outcome";
import {
  enforceKubernetesAccess,
  requireKubernetesChannel,
} from "../../terminal/kubernetes-access";
import { deliverFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import {
  resolveConfigCollectConfig,
  resolveConfigDeploymentSelection,
  resolveConfigServiceSelection,
  resolveConfigTenantSelection,
} from "./config";
import { buildConfigCoverage, buildConfigEvidence, configDetectors } from "./detector";
import { makeConfigTargetsInspect } from "./fact/inspect";
import type {
  CollectConfigCliOpts,
  ConfigCollectConfig,
  ConfigCollectContext,
  ConfigDiagnosis,
  ConfigInspectionFacts,
} from "./model";
import { makeConfigProbes } from "./probe";
import { buildConfigHtml, buildConfigHtmlSections, buildConfigSummary } from "./render";

export * from "./config";
export * from "./detector";
export * from "./model";
export * from "./probe";
export * from "./render";

/** commander 入口只编排目标选择、Inspect、Probe、Evidence/Detector 与交付。 */
export async function runCollectConfig(
  opts: CollectConfigCliOpts,
  plugin: PluginDefinition,
  injectedExecutor?: Executor,
  injectedTenantConfigReader?: TenantConfigReader,
  injectedTenantDirectory?: TenantDirectory,
  commandContext?: CommandContext,
): Promise<number> {
  const startedAt = new Date().toISOString();
  let config;
  try {
    config = resolveConfigCollectConfig(opts, plugin);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  terminalStdout.write(`[collect] namespace: ${config.namespace}（${config.namespaceSource}）\n`);
  const executor = injectedExecutor ?? new KubectlExecutor(config.kube);
  if (!injectedExecutor) {
    await requireKubernetesChannel({
      executor,
      profileName: config.profileName,
      kubeconfigSource: config.kube.kubeconfig ? "resolved" : "kubectl-default",
      namespace: config.namespace,
      commandContext,
    });
  }
  const authorization = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(authorization, {
    command: "doctor config",
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析要盘点配置的 Service",
    }],
  });
  let services;
  try {
    services = await resolveConfigServiceSelection({ config, catalog: plugin.services, executor });
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!services) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  config = { ...config, services };
  const includeDeploymentConfig = await resolveConfigDeploymentSelection({ config });
  config = { ...config, includeDeploymentConfig };
  terminalStdout.write(
    includeDeploymentConfig
      ? "[collect] Deployment Env/ConfigMap：已确认采集\n"
      : "[collect] Deployment Env/ConfigMap：已跳过（未确认采集）\n",
  );
  const deploymentNeeds = includeDeploymentConfig ? [{
    requirement: "preferred" as const,
    rule: { verb: "list" as const, resource: "deployments.apps" },
    purpose: "读取 Deployment Container/env 声明",
    fallback: "权限缺失时仍交付 Pod/Tenant 证据，Env 配置标记为缺失",
  }, {
    requirement: "preferred" as const,
    rule: { verb: "list" as const, resource: "configmaps" },
    purpose: "读取 Deployment 引用的 ConfigMap",
    fallback: "权限缺失时仍交付 Pod/Tenant 证据，ConfigMap 配置标记为缺失",
  }] : [];
  await enforceKubernetesAccess(authorization, {
    command: "doctor config",
    needs: [
      ...deploymentNeeds,
      {
        requirement: "preferred",
        rule: { verb: "list", resource: "pods" },
        purpose: "统计所选 Service 的 Pod、镜像与 Container 资源声明",
        fallback: "权限缺失时仍交付 Env/Tenant 配置，Pod 运行态标记为缺失",
      }, {
        requirement: "preferred",
        rule: { verb: "create", resource: "pods/portforward" },
        purpose: "访问 Plugin 声明的服务以补充租户配置",
        fallback: "权限缺失时仅交付已取得的 Kubernetes 配置",
      },
    ],
  });
  const tenantCapability = plugin.tenantConfiguration;
  const tenantDirectoryService = tenantCapability
    ? plugin.services.findWith(tenantCapability.directoryService, "tenantDirectory")
    : undefined;
  if (tenantCapability && !tenantDirectoryService) {
    terminalStderr.error(
      `Plugin '${plugin.id}' 的 Service '${tenantCapability.directoryService}' 未声明 tenantDirectory 能力\n`,
    );
    return 2;
  }
  const directoryContext = tenantDirectoryService && config.tenantConfiguration && !injectedTenantDirectory
    ? await openPluginContext(executor, config.kube, {
        env: config.profileName,
        config: commandContext?.profile.pluginConfig,
        databaseIdentity: config.fallbackIdentity,
        service: {
          name: config.tenantConfiguration.directoryTarget.service,
          port: config.tenantConfiguration.directoryTarget.port,
        },
        command: "doctor config",
        capability: tenantDirectoryService.capabilities.tenantDirectory,
        authorization,
      })
    : undefined;
  const tenantDirectory = injectedTenantDirectory ?? (
    tenantDirectoryService && config.tenantConfiguration
      ? tenantDirectoryService.capabilities.tenantDirectory.create(directoryContext!)
      : undefined
  );
  let selectedConfig: ConfigCollectConfig | undefined = config;
  let tenantSelectionFailure: string | undefined;
  if (tenantDirectory) {
    try {
      selectedConfig = await resolveConfigTenantSelection({
        config,
        directory: tenantDirectory,
        log: (line) => terminalStdout.write(`${line}\n`),
      });
    } catch (error) {
      tenantSelectionFailure = error instanceof Error ? error.message : String(error);
    } finally {
      await directoryContext?.dispose();
    }
  }
  if (tenantSelectionFailure) {
    terminalStderr.error(`${tenantSelectionFailure}\n`);
    return 2;
  }
  if (!selectedConfig) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  config = selectedConfig;

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-config-"));
  const staging = join(stagingRoot, config.reportName);
  const bundle = new EvidenceBundle(staging);
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  let facts: ConfigInspectionFacts | undefined;
  let diagnosis: ConfigDiagnosis | undefined;
  let diagnosisFailure: string | undefined;
  const ctx: ConfigCollectContext = {
    executor,
    authorization,
    pluginConfig: commandContext?.profile.pluginConfig ?? {},
    bundle,
    tenantConfigReader: injectedTenantConfigReader,
    log,
  };

  const writeManifest = () => bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      namespace: config.namespace,
      services: config.services.join(","),
      tenant_id: config.tenantId ?? "not-requested",
      tenant_name: config.tenantName ?? "not-requested",
    },
    inspectionFacts: facts ? {
      serviceTargets: facts.serviceTargets,
      deploymentConfiguration: facts.deploymentConfiguration,
      tenantDatabaseTarget: facts.tenantDatabaseTarget,
      tenantRequest: facts.tenantRequest,
    } : {},
    params: {
      services: config.services,
      deployment_config: config.includeDeploymentConfig,
      tenant_id: config.tenantId ?? null,
      tenant_name: config.tenantName ?? null,
      tenant_config_service: config.tenantConfiguration?.databaseService ?? null,
      tenant_directory_service: config.tenantConfiguration?.directoryTarget.service ?? null,
      output_format: config.format,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  const fail = async (reason: string): Promise<number> => {
    bundle.settle(reason);
    bundle.writeSummary(diagnosis ? buildConfigSummary(diagnosis) : `# Service 实际配置统计失败\n\n${reason}\n`);
    writeManifest();
    const failure = await deliverFailureBundle({
      bundleDir: staging,
      bundleName: config.reportName,
      requestedOutput: opts.output,
      collectCode: 1,
      reason,
    });
    if (failure.packed.ok) {
      rmSync(stagingRoot, { recursive: true, force: true });
      terminalStderr.error(`[collect] 配置采集失败，Evidence Bundle: ${failure.path}\n`);
    } else {
      terminalStderr.error(`[collect] 失败 Bundle 打包失败，原始证据保留在目录: ${staging}\n`);
    }
    return 1;
  };

  try {
    facts = await runInspects(
      [makeConfigTargetsInspect(config, tenantCapability)],
      ctx,
      log,
    ) as ConfigInspectionFacts;
    diagnosis = await runDiagnosis({
      ctx,
      facts,
      config,
      probes: makeConfigProbes(facts, config),
      log,
      buildEvidence: buildConfigEvidence,
      detectors: configDetectors,
      buildCoverage: buildConfigCoverage,
    });
  } catch (error) {
    reportError(error, { context: "doctor config/diagnosis", summary: "配置诊断失败" });
    diagnosisFailure = error instanceof Error ? error.message : String(error);
  } finally {
    await ctx?.closeTenantAccess?.();
  }
  if (diagnosisFailure || !diagnosis) return await fail(diagnosisFailure ?? "配置诊断未形成结果");

  const outcome = evaluateCollectOutcome(diagnosis.coverage.map((item) => item.status === "sufficient"));
  if (outcome.exitCode !== 0) {
    const reason = diagnosis.coverage.flatMap((item) => item.missingEvidence).join("；") || "未取得完整配置证据";
    return await fail(reason);
  }

  bundle.writeSummary(buildConfigSummary(diagnosis));
  writeManifest();
  if (config.format === "json") {
    terminalStdout.write(`${JSON.stringify(diagnosis, null, 2)}\n`);
    rmSync(stagingRoot, { recursive: true, force: true });
    return 0;
  }
  if (config.format === "md") {
    try {
      copyFileSync(join(staging, "summary.md"), config.outputPath!);
    } catch (error) {
      reportError(error, { context: "doctor config/markdown-report", summary: "Markdown 报告生成失败" });
      return await fail(error instanceof Error ? error.message : String(error));
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    terminalStdout.success(`[collect] Markdown 报告: ${config.outputPath}\n`);
    return 0;
  }
  try {
    writeHtmlReport(staging, config.outputPath!, {
      title: "doctor Service 配置统计",
      profileName: config.profileName,
      summaryHtml: buildConfigHtml(diagnosis),
      sections: buildConfigHtmlSections(diagnosis),
    });
  } catch (error) {
    reportError(error, { context: "doctor config/html-report", summary: "HTML 报告生成失败" });
    return await fail(error instanceof Error ? error.message : String(error));
  }
  rmSync(stagingRoot, { recursive: true, force: true });
  terminalStdout.success(`[collect] HTML 报告: ${config.outputPath}\n`);
  return 0;
}
