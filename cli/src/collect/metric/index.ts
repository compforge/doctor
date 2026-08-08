import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import type { Executor } from "../../infra/k8s/executor";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { promptNamedChoices } from "../../terminal/service-selection";
import { runDiagnosis } from "../engine";
import { EvidenceBundle } from "../evidence";
import { runInspects } from "../inspect-engine";
import { evaluateCollectOutcome } from "../outcome";
import { deliverFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import { resolveMetricConfig } from "./config";
import { buildMetricCoverage, buildMetricEvidence, metricDetectors } from "./detector";
import { makeMetricSourceInspect } from "./fact/inspect";
import type {
  CollectMetricCliOpts,
  MetricCollectContext,
  MetricConfig,
  MetricDiagnosis,
  MetricInspectionFacts,
  MetricWindowObservation,
} from "./model";
import { prepareMetricSource, type MetricSourcePreparation } from "./preparation";
import { makeMetricProbes } from "./probe";
import { buildMetricSections, buildMetricSummary } from "./render";

export * from "./config";
export * from "./detector";
export * from "./fact/inspect";
export * from "./model";
export * from "./preparation";
export * from "./probe";
export * from "./query";
export * from "./render";

export async function runCollectMetric(
  opts: CollectMetricCliOpts,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
  injectedExecutor?: Executor,
): Promise<number> {
  let config = await resolveMetricConfig(
    opts,
    plugin.services,
    !!(process.stdin.isTTY && process.stdout.isTTY),
    commandContext,
  );
  if (!config) return 130;
  if (!config.servicesExplicit && process.stdin.isTTY && process.stdout.isTTY) {
    const selected = await promptNamedChoices({
      choices: plugin.services.servicesWith("metric").map((service) => ({ name: service.name })),
      defaults: config.services,
      candidateType: "Service",
      context: { purpose: "确定 Metric 分析范围" },
    });
    if (!selected) return 130;
    config = { ...config, services: selected };
  }
  if (!config.services.length) {
    terminalStderr.error("[collect] 未选择任何 Metric Service\n");
    return 2;
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-metric-"));
  const staging = join(stagingRoot, config.reportName);
  const bundle = new EvidenceBundle(staging, [
    { id: "metric-window", title: "Metric 采集窗口", risk: "observe" },
    ...config.services.map((service) => ({
      id: `metric-query-${service}`,
      title: `${service} PromQL 查询`,
      risk: "observe" as const,
    })),
  ]);
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  let preparation: MetricSourcePreparation | undefined;
  let facts: MetricInspectionFacts | undefined;
  let diagnosis: MetricDiagnosis | undefined;
  let failure: string | undefined;
  try {
    preparation = await prepareMetricSource(config, plugin, commandContext, injectedExecutor);
    terminalStdout.write(preparation.sourceKind === "remote"
      ? `[collect] metric source: remote Prometheus ${config.prometheus!.url}\n`
      : `[collect] metric source: embedded Prombed（interval=${config.intervalMs}ms）\n`);
    if (config.watch.mode === "until-interrupt") {
      terminalStdout.write("[collect] 正在监听；按 Ctrl+C 停止并生成报告。\n");
    } else if (preparation.sourceKind === "embedded" && config.watch.mode === "duration") {
      terminalStdout.write(`[collect] watch ${config.watch.label}；Ctrl+C 可提前结束并生成报告。\n`);
    }
    const ctx: MetricCollectContext = {
      source: preparation.source,
      sourceKind: preparation.sourceKind,
      embeddedSource: preparation.embeddedSource,
      signal: controller.signal,
      bundle,
    };
    facts = await runInspects([makeMetricSourceInspect(preparation.targetCount)], ctx, log);
    diagnosis = await runDiagnosis({
      ctx,
      facts,
      config,
      probes: makeMetricProbes(config.services, plugin.services),
      log,
      buildEvidence: buildMetricEvidence,
      detectors: metricDetectors,
      buildCoverage: buildMetricCoverage,
    });
  } catch (error) {
    reportError(error, { context: "doctor metric/diagnosis", summary: "Metric 诊断失败" });
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    preparation?.close();
  }

  if (failure || !diagnosis || !facts) {
    const reason = failure ?? "Metric 诊断未形成结果";
    bundle.settle(reason);
    bundle.writeSummary(`# Metric diagnosis\n\n${reason}\n`);
    writeMetricManifest(bundle, config, facts, diagnosis);
    const delivered = await deliverFailureBundle({
      bundleDir: staging,
      bundleName: config.reportName,
      requestedOutput: opts.output,
      collectCode: 1,
      reason,
    });
    if (delivered.packed.ok) {
      rmSync(stagingRoot, { recursive: true, force: true });
      terminalStderr.error(`[collect] Metric 采集失败，Evidence Bundle: ${delivered.path}\n`);
    } else {
      terminalStderr.error(`[collect] 失败 Bundle 打包失败，原始证据保留在目录: ${staging}\n`);
    }
    return 1;
  }

  bundle.writeSummary("# Metric diagnosis\n");
  writeMetricManifest(bundle, config, facts, diagnosis);
  try {
    writeHtmlReport(bundle.dir, config.outputPath, {
      title: "doctor Metric 诊断报告",
      profileName: config.profileName,
      summaryHtml: buildMetricSummary(diagnosis),
      sections: buildMetricSections(diagnosis),
    });
  } catch (error) {
    reportError(error, { context: "doctor metric/html-report", summary: "Metric HTML 报告生成失败" });
    const reason = error instanceof Error ? error.message : String(error);
    const delivered = await deliverFailureBundle({
      bundleDir: staging,
      bundleName: config.reportName,
      requestedOutput: opts.output,
      collectCode: 1,
      reason,
    });
    if (delivered.packed.ok) rmSync(stagingRoot, { recursive: true, force: true });
    return 1;
  }
  rmSync(stagingRoot, { recursive: true, force: true });
  terminalStdout.success(`[collect] Metric HTML 报告: ${config.outputPath}\n`);
  return evaluateCollectOutcome(
    diagnosis.coverage.map((item) => item.status === "sufficient"),
  ).exitCode;
}

function metricWindow(diagnosis: MetricDiagnosis | undefined): MetricWindowObservation | undefined {
  return diagnosis?.evidence.observations.find(
    (item): item is MetricWindowObservation => item.kind === "metric-window",
  );
}

function writeMetricManifest(
  bundle: EvidenceBundle,
  config: MetricConfig,
  facts: MetricInspectionFacts | undefined,
  diagnosis: MetricDiagnosis | undefined,
): void {
  const window = metricWindow(diagnosis);
  const now = new Date().toISOString();
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: { namespace: config.namespace, services: config.services.join(",") },
    inspectionFacts: facts ? { source: facts.source } : {},
    params: {
      source: facts?.source.status === "collected" ? facts.source.kind : undefined,
      watch: config.watch.label,
      interval_ms: config.intervalMs,
      prometheus: config.prometheus ? config.prometheus.url : undefined,
    },
    startedAt: window ? new Date(window.startedAt).toISOString() : now,
    finishedAt: window ? new Date(window.finishedAt).toISOString() : now,
  });
}
