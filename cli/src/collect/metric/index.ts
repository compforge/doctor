import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import type { Executor } from "../../infra/k8s/executor";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { promptNamedChoices } from "../../terminal/service-selection";
import { runCollect } from "../engine";
import { EvidenceBundle } from "../evidence";
import { evaluateCollectOutcome } from "../outcome";
import { recordFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import { resolveMetricConfig } from "./config";
import { buildMetricCoverage, buildMetricEvidence, metricDetectors } from "./detector";
import { makeMetricSourceInspect } from "./fact/inspect";
import type {
  CollectMetricCliOpts,
  MetricCommandContext,
  MetricConfig,
  MetricDiagnosis,
  MetricInspectionFacts,
  MetricWindowObservation,
  MetricRunControl,
} from "./model";
import { prepareMetricSource, type MetricSourcePreparation } from "./preparation";
import { makeMetricProbes } from "./probe";
import { buildMetricSections, buildMetricSummary } from "./render";
import { selectedMetricStoreKinds } from "./store/collector";

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
  commandContext: CommandContext,
  injectedExecutor?: Executor,
  control?: MetricRunControl,
): Promise<number> {
  let config = await resolveMetricConfig(
    opts,
    plugin.services,
    commandContext,
    !!(process.stdin.isTTY && process.stdout.isTTY),
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
  commandContext.artifacts.add("metric", staging);
  const storeKinds = selectedMetricStoreKinds(plugin.services, config.services);
  const bundle = new EvidenceBundle(staging, [
    { id: "metric-window", title: "Metric 采集窗口", risk: "observe" },
    ...config.services.map((service) => ({
      id: `metric-query-${service}`,
      title: `${service} PromQL 查询`,
      risk: "observe" as const,
    })),
    ...storeKinds.map((kind) => ({
      id: `metric-query-${kind}-store`,
      title: `${kind} Store PromQL 查询`,
      risk: "observe" as const,
    })),
  ]);
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  const onExternalAbort = () => controller.abort(control?.signal?.reason);
  process.once("SIGINT", onInterrupt);
  if (control?.signal?.aborted) onExternalAbort();
  else control?.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  let preparation: MetricSourcePreparation | undefined;
  let facts: MetricInspectionFacts | undefined;
  let diagnosis: MetricDiagnosis | undefined;
  let failure: string | undefined;
  try {
    preparation = await prepareMetricSource(config, plugin, commandContext, injectedExecutor);
    terminalStdout.write(preparation.sourceKind === "remote"
      ? `[collect] metric source: remote Prometheus ${config.prometheus!.url}\n`
      : preparation.sourceKind === "hybrid"
        ? `[collect] metric source: remote Prometheus + embedded Store sampling（interval=${config.intervalMs}ms）\n`
      : `[collect] metric source: embedded Prombed（interval=${config.intervalMs}ms）\n`);
    if (preparation.storeFallbackReason) {
      terminalStdout.warning(
        `[collect] Store 实时补充采样不可用：${preparation.storeFallbackReason}；`
        + "继续从远端 Prometheus 查询 Store exporter 指标\n",
      );
    }
    if (preparation.exporterStoreTargets || preparation.directStoreTargets) {
      terminalStdout.write(
        `[collect] store metrics: exporter=${preparation.exporterStoreTargets}，direct-fallback=${preparation.directStoreTargets}\n`,
      );
    }
    if (config.watch.mode === "until-interrupt") {
      terminalStdout.write("[collect] 正在监听；按 Ctrl+C 停止并生成报告。\n");
    } else if (preparation.embeddedSource && config.watch.mode === "duration") {
      terminalStdout.write(`[collect] watch ${config.watch.label}；Ctrl+C 可提前结束并生成报告。\n`);
    }
    const ctx: MetricCommandContext = {
      command: commandContext,
      config,
      source: preparation.source,
      storeSource: preparation.storeSource,
      sourceKind: preparation.sourceKind,
      embeddedSource: preparation.embeddedSource,
      collectSupplement: preparation.collectSupplement,
      signal: controller.signal,
      onWindowStart: control?.onWindowStart,
      bundle,
    };
    const execution = await runCollect({
      ctx,
      config,
      inspects: [makeMetricSourceInspect(preparation.targetCount)],
      planProbes: () => makeMetricProbes(config.services, plugin.services),
      log,
      buildEvidence: buildMetricEvidence,
      detectors: metricDetectors,
      buildCoverage: buildMetricCoverage,
    });
    facts = execution.facts;
    diagnosis = execution.diagnosis;
  } catch (error) {
    reportError(error, { context: "doctor metric/diagnosis", summary: "Metric 诊断失败" });
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    control?.signal?.removeEventListener("abort", onExternalAbort);
    await preparation?.close();
  }

  if (failure || !diagnosis || !facts) {
    const reason = failure ?? "Metric 诊断未形成结果";
    bundle.settle(reason);
    bundle.writeSummary(`# Metric diagnosis\n\n${reason}\n`);
    writeMetricManifest(bundle, config, facts, diagnosis);
    recordFailureBundle({
      bundleDir: staging,
      collectCode: 1,
      reason,
    });
    return 1;
  }

  bundle.writeSummary("# Metric diagnosis\n");
  writeMetricManifest(bundle, config, facts, diagnosis);
  writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
  const reportPath = join(staging, "report.html");
  try {
    writeHtmlReport(bundle.dir, reportPath, {
      title: "doctor Metric 诊断报告",
      profileName: config.profileName,
      summaryHtml: buildMetricSummary(diagnosis),
      sections: buildMetricSections(diagnosis),
    });
  } catch (error) {
    reportError(error, { context: "doctor metric/html-report", summary: "Metric HTML 报告生成失败" });
    const reason = error instanceof Error ? error.message : String(error);
    recordFailureBundle({
      bundleDir: staging,
      collectCode: 1,
      reason,
    });
    return 1;
  }
  const exitCode = evaluateCollectOutcome(
    diagnosis.coverage.map((item) => item.status === "sufficient"),
  ).exitCode;
  if (config.format === "html") {
    return exitCode;
  }
  return exitCode;
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
