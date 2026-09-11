import type { PluginDefinition } from "@compforge/doctor-plugin";
import { KubectlExecutor, type Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { CommandContext } from "../../command";
import { commandOutcome, resolveKubernetesCommandContext, type CommandResult } from "../../command";
import { immutableServiceProbeFacts } from "../../plugin/evidence";
import {
  enforceKubernetesAccess,
  requireKubernetesChannel,
} from "../../terminal/kubernetes-access";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runCollect } from "../engine";
import { EvidenceBundle } from "../evidence";
import { collectCommandOutcome, evaluateCollectOutcome } from "../outcome";
import { recordFailureBundle } from "../output/failure-bundle";
import {
  buildInspectCoverage,
  buildInspectEvidence,
  makeInspectDetectors,
  projectInspectServiceFacts,
} from "./detector";
import { makeServiceTargetsInspect } from "./fact/inspect";
import type {
  CollectInspectCliOpts,
  InspectCommandContext,
  InspectDiagnosis,
  InspectFacts
} from "./model";
import {
  resolveInspectConfig,
  resolveInspectDependencySelection,
  resolveInspectDeploymentSelection,
  resolveInspectServiceSelection,
} from "./options";
import { makeInspectProbes } from "./probe";
import { buildInspectSummary } from "./render";

export * from "./detector";
export * from "./model";
export * from "./options";
export * from "./probe";
export * from "./render";

/** commander 入口只编排目标选择、Inspect、Probe、Evidence/Detector 与交付。 */
export async function runCollectInspect(
  opts: CollectInspectCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedExecutor?: Executor,
): Promise<CommandResult<void>> {
  const startedAt = new Date().toISOString();
  let config;
  try {
    config = await resolveInspectConfig(opts, plugin, commandContext, injectedExecutor);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return commandOutcome(2);
  }
  if (!config) {
    terminalStderr.warning("[collect] 已取消\n");
    return commandOutcome(130);
  }
  const executor = injectedExecutor ?? new KubectlExecutor(config.kube);
  if (!injectedExecutor) {
    await requireKubernetesChannel({
      executor,
      profileName: config.profileName,
      kubeconfigSource: config.kube.kubeconfig ? "resolved" : "kubectl-default",
      commandContext,
    });
  }
  terminalStdout.write(`[collect] namespace: ${config.namespace}（${config.namespaceSource}）\n`);
  const authorization = resolveKubernetesCommandContext(executor, commandContext).access;
  let services;
  try {
    services = await resolveInspectServiceSelection({ config, catalog: plugin.services, executor });
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return commandOutcome(2);
  }
  if (!services) {
    terminalStderr.warning("[collect] 已取消\n");
    return commandOutcome(130);
  }
  config = { ...config, services };
  const selectedDefinitions = services.map((name) => plugin.services.find(name)!);
  const includeDeploymentConfig = await resolveInspectDeploymentSelection({ config });
  if (includeDeploymentConfig === undefined) {
    terminalStderr.warning("[collect] 已取消\n");
    return commandOutcome(130);
  }
  config = { ...config, includeDeploymentConfig };
  terminalStdout.write(
    includeDeploymentConfig
      ? "[collect] Deployment Env/ConfigMap：已确认采集\n"
      : "[collect] Deployment Env/ConfigMap：已跳过（未确认采集）\n",
  );
  const includeDependencies = await resolveInspectDependencySelection({ config });
  if (includeDependencies === undefined) {
    terminalStderr.warning("[collect] 已取消\n");
    return commandOutcome(130);
  }
  config = { ...config, includeDependencies };
  terminalStdout.write(
    includeDependencies
      ? "[collect] 应用依赖及版本：已确认采集\n"
      : "[collect] 应用依赖及版本：已跳过（未确认进入业务 Container）\n",
  );
  const deploymentNeeds = includeDeploymentConfig ? [{
    requirement: "preferred" as const,
    rule: { verb: "list" as const, resource: "deployments.apps" },
    purpose: "读取 Deployment Container/env 声明",
    fallback: "权限缺失时仍交付 Pod 证据，Env 配置标记为缺失",
  }, {
    requirement: "preferred" as const,
    rule: { verb: "list" as const, resource: "configmaps" },
    purpose: "读取 Deployment 引用的 ConfigMap",
    fallback: "权限缺失时仍交付 Pod 证据，ConfigMap 配置标记为缺失",
  }] : [];
  const dependencyNeeds = includeDependencies ? [{
    requirement: "preferred" as const,
    rule: { verb: "create" as const, resource: "pods/exec" },
    purpose: "进入每个不同业务镜像的代表 Container 采集应用依赖及版本",
    fallback: "权限缺失时仍交付 Pod 与 Env 配置，依赖清单标记为缺失",
  }] : [];
  await enforceKubernetesAccess(authorization, {
    command: "doctor inspect",
    needs: [
      ...deploymentNeeds,
      {
        requirement: "preferred",
        rule: { verb: "list", resource: "pods" },
        purpose: "统计所选 Service 的 Pod、镜像与 Container 资源声明",
        fallback: "权限缺失时仍交付 Env 配置，Pod 运行态标记为缺失",
      },
      ...(selectedDefinitions.some((service) => service.workloads.some(
        (workload) => workload.discovery.kind === "kubernetes-service",
      )) ? [{
        requirement: "preferred" as const,
        rule: { verb: "list" as const, resource: "services" },
        purpose: "解析所选 Workload 声明的 Kubernetes Service",
        fallback: "仅 Pod selector Workload 可继续解析",
      }] : []),
      ...dependencyNeeds,
    ],
  });

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-inspect-"));
  const staging = join(stagingRoot, config.reportName);
  commandContext.artifacts.add({ command: "inspect", path: staging });
  const bundle = new EvidenceBundle(staging);
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  let facts: InspectFacts | undefined;
  let diagnosis: InspectDiagnosis | undefined;
  let diagnosisFailure: string | undefined;
  const ctx: InspectCommandContext = {
    command: commandContext,
    config,
    executor,
    authorization,
    bundle,
    log,
  };

  const writeManifest = () => bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      namespace: config.namespace,
      services: config.services.join(","),
    },
    inspectionFacts: facts ? {
      serviceTargets: facts.serviceTargets,
      deploymentConfiguration: facts.deploymentConfiguration,
      dependencyTargets: facts.dependencyTargets,
    } : {},
    params: {
      services: config.services,
      deployment_config: config.includeDeploymentConfig,
      dependencies: config.includeDependencies,
      output_format: config.format,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  const fail = async (reason: string): Promise<number> => {
    bundle.settle(reason);
    bundle.writeSummary(diagnosis ? buildInspectSummary(diagnosis) : `# Service Inspect 失败\n\n${reason}\n`);
    writeManifest();
    recordFailureBundle({
      bundleDir: staging,
      collectCode: 1,
      reason,
    });
    return 1;
  };

  try {
    const execution = await runCollect({
      ctx,
      config,
      inspects: [makeServiceTargetsInspect(config, plugin.services)],
      planProbes: (collectedFacts) => {
        const probeFacts = immutableServiceProbeFacts(
          projectInspectServiceFacts(collectedFacts, config.services),
        );
        return makeInspectProbes(
          collectedFacts,
          config,
          plugin.services,
          probeFacts,
        );
      },
      log,
      buildEvidence: buildInspectEvidence,
      detectors: makeInspectDetectors(plugin.id, plugin.services, config.services),
      buildCoverage: buildInspectCoverage,
    });
    facts = execution.facts;
    diagnosis = execution.diagnosis;
  } catch (error) {
    reportError(error, { context: "doctor inspect/diagnosis", summary: "Service Inspect 失败" });
    diagnosisFailure = error instanceof Error ? error.message : String(error);
  }
  if (diagnosisFailure || !diagnosis) return commandOutcome(await fail(diagnosisFailure ?? "配置诊断未形成结果"));

  const outcome = evaluateCollectOutcome(diagnosis.coverage.map((item) => item.status === "sufficient"));
  if (outcome.exitCode !== 0) {
    const reason = diagnosis.coverage.flatMap((item) => item.missingEvidence).join("；") || "未取得完整配置证据";
    return commandOutcome(await fail(reason));
  }

  bundle.writeSummary(buildInspectSummary(diagnosis));
  writeManifest();
  writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
  return collectCommandOutcome(outcome);
}
