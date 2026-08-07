import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import { KubectlExecutor, type Executor } from "../../infra/k8s/executor";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runDiagnosis } from "../engine";
import type { CommandContext } from "../../command";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { runInspects } from "../inspect-engine";
import { evaluateCollectOutcome } from "../outcome";
import { requireKubernetesChannel } from "../../terminal/kubernetes-access";
import { deliverFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import { resolveDataConfig, resolveDataServiceSelection } from "./config";
import { buildDataCoverage, buildDataEvidence, makeDataDetectors } from "./detector";
import { makeDataInspect } from "./fact/inspect";
import type {
  CollectDataCliOpts,
  DataCollectContext,
  DataDiagnosis,
  DataInspectionFacts,
} from "./model";
import { prepareDataAccess, type DataAccessPreparation } from "./preparation";
import { makeDataServiceProbes } from "./probe";
import { buildDataHtml, buildDataSummary } from "./render";

export * from "./config";
export * from "./detector";
export * from "./model";
export * from "./probe";

function dataOutcomes(services: readonly string[], plugin: PluginDefinition): OutcomeDecl[] {
  return services.flatMap((service) => {
    const capability = plugin.services.findWith(service, "data")!.capabilities.data;
    return [
      ...(capability.expands?.length ? [{
        id: `data-expand-${service}`,
        title: `${service} 业务 ID 扩展`,
        risk: "observe" as const,
      }] : []),
      {
        id: `data-provide-${service}`,
        title: `${service} 业务数据贡献`,
        risk: "observe" as const,
      },
    ];
  });
}

/** commander 入口只编排 Service 选择、Inspect、Probe、Detector 与最终交付。 */
export async function runCollectData(
  opts: CollectDataCliOpts,
  plugin: PluginDefinition,
  injectedExecutor?: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
  commandContext?: CommandContext,
): Promise<number> {
  const startedAt = new Date().toISOString();
  let config;
  try {
    config = resolveDataConfig(opts, plugin.services);
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
  let selections;
  try {
    selections = await resolveDataServiceSelection({ config, catalog: plugin.services });
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!selections) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  for (const { service } of selections) {
    const capability = plugin.services.findWith(service, "data")!.capabilities.data;
    terminalStdout.write(
      `[collect] data capability: ${service}（provides=${capability.provides.join(",")}`
      + `${capability.expands?.length ? `；expands=${capability.expands.join(",")}` : ""}）\n`,
    );
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-data-"));
  const staging = join(stagingRoot, config.reportName);
  const bundle = new EvidenceBundle(
    staging,
    dataOutcomes(selections.map((item) => item.service), plugin),
  );
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  let access: DataAccessPreparation | undefined;
  let facts: DataInspectionFacts = { services: {} };
  let diagnosis: DataDiagnosis | undefined;
  let diagnosisFailure: string | undefined;

  const writeManifest = () => bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      namespace: config.namespace,
      input_ids: config.ids,
      services: selections.map((item) => item.service),
    },
    inspectionFacts: { services: facts.services },
    params: {
      services: selections.map((item) => item.service),
      data_capabilities: Object.fromEntries(selections.map(({ service }) => {
        const capability = plugin.services.findWith(service, "data")!.capabilities.data;
        return [service, {
          provides: capability.provides,
          expands: capability.expands ?? [],
        }];
      })),
      output_format: config.format,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  const fail = async (reason: string): Promise<number> => {
    bundle.settle(reason);
    bundle.writeSummary(diagnosis ? buildDataSummary(diagnosis) : `# 业务数据汇集诊断失败\n\n${reason}\n`);
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
      terminalStderr.error(`[collect] Data 采集失败，Evidence Bundle: ${failure.path}\n`);
    } else {
      terminalStderr.error(`[collect] 失败 Bundle 打包失败，原始证据保留在目录: ${staging}\n`);
    }
    return 1;
  };

  try {
    access = await prepareDataAccess(
      executor,
      config,
      selections,
      plugin.services,
      injectedContexts,
      commandContext,
    );
    const pluginContexts = Object.fromEntries(
      access.confirmed.flatMap((item) => item.context ? [[item.service, item.context]] : []),
    );
    const ctx: DataCollectContext = { pluginContexts, bundle, log };
    facts = await runInspects([makeDataInspect(access)], ctx, log);
    diagnosis = await runDiagnosis({
      ctx,
      facts,
      config,
      probes: makeDataServiceProbes(selections, plugin.services),
      log,
      buildEvidence: buildDataEvidence,
      detectors: makeDataDetectors(plugin.services),
      buildCoverage: buildDataCoverage,
    });
  } catch (error) {
    reportError(error, { context: "doctor data/diagnosis", summary: "Data 诊断失败" });
    diagnosisFailure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await access?.close();
    } catch (error) {
      reportError(error, { context: "doctor data/close", summary: "Data 访问资源回收失败" });
      diagnosisFailure ??= error instanceof Error ? error.message : String(error);
    }
  }
  if (diagnosisFailure || !diagnosis) return await fail(diagnosisFailure ?? "Data 诊断未形成结果");

  const requirements = selections.map((selection) => (
    diagnosis.evidence.observations.some((item) => (
      item.service === selection.service && item.summary.resolvedAs !== "unresolved"
    ))
  ));
  const outcome = evaluateCollectOutcome(requirements);
  if (outcome.exitCode !== 0) {
    const reason = diagnosis.coverage[0]?.missingEvidence.join("；") || "未取得所选 Service 的业务记录";
    return await fail(reason);
  }

  bundle.writeSummary(buildDataSummary(diagnosis));
  writeManifest();
  if (config.format === "json") {
    terminalStdout.write(`${JSON.stringify(diagnosis, null, 2)}\n`);
    rmSync(stagingRoot, { recursive: true, force: true });
    return 0;
  }
  try {
    writeHtmlReport(staging, config.outputPath!, {
      title: "doctor Data 业务数据汇集报告",
      profileName: config.profileName,
      summaryHtml: buildDataHtml(diagnosis),
    });
  } catch (error) {
    reportError(error, { context: "doctor data/html-report", summary: "HTML 报告生成失败" });
    return await fail(error instanceof Error ? error.message : String(error));
  }
  rmSync(stagingRoot, { recursive: true, force: true });
  terminalStdout.success(`[collect] HTML 报告: ${config.outputPath}\n`);
  return 0;
}
