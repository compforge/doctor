import { projectDataFacts } from "./projection";
import { CommandInputError, CommandStatus, aggregateCommandStatus, type CommandResult } from "../../command";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/doctor-toolkit/kubernetes/executor";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runCollectBatch } from "../engine";
import type { CommandContext } from "../../command";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { evaluateCollectOutcome, collectCommandOutcome } from "../outcome";
import { recordFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import { failedReportHtml, writeTabbedReport } from "../output/tabbed-report";
import { resolveDataServiceSelection } from "./config";
import { buildDataCoverage, buildDataEvidence, makeDataDetectors } from "./detector";
import { makeDataContributionInspect } from "./capability/collect";
import { prepareDataCommand, type DataCommandContext } from "./context";
import { makeDataInspect } from "./fact/inspect";
import type {
  CollectDataCliOpts,
  DataDiagnosis,
  DataOutput,
  DataConfig,
  DataFacts,
} from "./model";
import { prepareDataAccess, type DataAccessPreparation } from "./preparation";
import { buildDataHtml, buildDataSummary } from "./render";

export * from "./config";
export * from "./context";
export * from "./capability/collect";
export * from "./detector";
export * from "./model";

function dataOutcomes(services: readonly string[], plugin: PluginDefinition): OutcomeDecl[] {
  return services.flatMap((service) => {
    const capability = plugin.services.findWithContribution(service, "inspect")!.contributions.inspect;
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

/**
 * @spec Every Data invocation acquires the complete ID list once and diagnoses each root projection
 * @why Per-ID diagnosis must not observe sibling roots or perform another Inspect pass
 */
export async function runCollectData(
  opts: CollectDataCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedExecutor?: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<CommandResult<DataOutput>> {
  let dataCommand;
  let selections;
  try {
    dataCommand = await prepareDataCommand(opts, plugin.services, commandContext, injectedExecutor);
    if (dataCommand) selections = await resolveDataServiceSelection({ config: dataCommand.config, catalog: plugin.services });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    terminalStderr.error(`${reason}\n`);
    return { status: CommandStatus.Failed, reason, error: new CommandInputError(reason), artifacts: [] };
  }
  if (!dataCommand || !selections) {
    terminalStderr.warning("[collect] 已取消\n");
    return { status: CommandStatus.Cancelled, artifacts: [] };
  }
  const { config } = dataCommand;
  const services = selections.map(item => item.service);
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  log(`[collect] namespace: ${config.namespace}（${config.namespaceSource}）`);
  const outcomes = dataOutcomes(services, plugin);
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-data-"));
  const staging = join(stagingRoot, config.reportName);
  const summary = commandContext.artifacts.add({ command: "data", path: staging });
  const bundle = new EvidenceBundle(staging, outcomes);
  const startedAt = new Date().toISOString();
  // Each item has its own evidence directory from the outset, including singleton input.
  const targets = config.ids.map((bizId, index) => {
    const path = join(stagingRoot, `${config.reportName}-biz-${index + 1}`);
    return { bizId, artifact: commandContext.artifacts.add({ command: "data", path }),
      bundle: new EvidenceBundle(path, outcomes), config: { ...config, ids: [bizId] } };
  });
  let facts: DataFacts = { services: {}, capabilityResults: [] };
  let diagnoses: PromiseSettledResult<{ facts: Readonly<DataFacts>; diagnosis: DataDiagnosis }>[];
  let access: DataAccessPreparation | undefined;
  try {
    access = await prepareDataAccess(dataCommand, selections, plugin.services, injectedContexts);
    const pluginContexts = Object.fromEntries(access.confirmed.flatMap(item => item.context ? [[item.service, item.context]] : []));
    const ctx: DataCommandContext = { ...dataCommand, pluginContexts, bundle, log };
    const execution = await runCollectBatch({
      ctx,
      inspects: [makeDataInspect(access), makeDataContributionInspect({ selections, catalog: plugin.services, config })],
      items: targets.map(target => ({
        ctx: { ...ctx, config: target.config, bundle: target.bundle }, config: target.config,
        projectFacts: (snapshot: Readonly<DataFacts>) => projectDataFacts(snapshot, target.bizId),
      })),
      checkpointFacts: snapshot => { facts = snapshot; },
      signal: commandContext.signal,
      planProbes: (_facts, itemConfig) => {
        terminalStdout.warning(`\n[collect:data] biz-id: ${itemConfig.ids[0]}\n`);
        return [];
      }, log, buildEvidence: buildDataEvidence,
      detectors: makeDataDetectors(plugin.id, plugin.services, services), buildCoverage: buildDataCoverage,
    });
    diagnoses = execution.items;
  } catch (error) {
    reportError(error, { context: "doctor data/collect", summary: "Data 采集失败" });
    diagnoses = targets.map(() => ({ status: "rejected", reason: error }));
  } finally {
    try { await access?.close(); }
    catch (error) { reportError(error, { context: "doctor data/close", summary: "Data 访问资源回收失败" }); }
  }

  const items: DataOutput["items"][number][] = [];
  const groups: Record<string, DataDiagnosis | { error: string }> = {};
  const tabs = [];
  for (const [index, target] of targets.entries()) {
    const result = diagnoses[index]!;
    const diagnosis = result.status === "fulfilled" ? result.value.diagnosis : undefined;
    const projected = result.status === "fulfilled" ? result.value.facts : projectDataFacts(facts, target.bizId);
    let reason = result.status === "rejected" ? String(result.reason instanceof Error ? result.reason.message : result.reason) : undefined;
    let status = commandContext.signal.aborted ? CommandStatus.Cancelled : CommandStatus.Failed;
    if (diagnosis) {
      const outcome = evaluateCollectOutcome(services.map(service => projected.capabilityResults.some(item =>
        item.status === "collected" && item.service === service && item.result.resolution.resolvedAs !== "unresolved")));
      status = collectCommandOutcome(outcome).status;
      if (outcome.exitCode) reason = diagnosis.coverage[0]?.missingEvidence.join("；") || "未取得所选 Service 的业务记录";
    }
    try {
      writeDataEvidence(target.bundle, target.config, plugin, services, projected, startedAt, diagnosis, reason);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      status = CommandStatus.Failed;
      reportError(error, { context: `doctor data/output ${target.bizId}`, summary: "Data 产物写入失败" });
    }
    items.push({ bizId: target.bizId, status, artifacts: [target.artifact], diagnosis, ...(reason ? { reason } : {}) });
    groups[target.bizId] = diagnosis ?? { error: reason ?? "未形成诊断结果" };
    const html = join(target.artifact.path, "report.html");
    tabs.push({ key: `biz-${index + 1}`, label: target.bizId,
      status: existsSync(html) ? "delivered" as const : "failed" as const,
      html: existsSync(html) ? readFileSync(html, "utf8") : failedReportHtml(`Data 诊断失败：${target.bizId}`, reason ?? "未形成诊断报告") });
  }
  writeDataManifest(bundle, config, plugin, services, facts, startedAt);
  bundle.writeSummary(`# 业务数据汇集\n\n${items.map(item => `- ${item.bizId}: ${item.status}`).join("\n")}\n`);
  writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify({ groups }, null, 2)}\n`, "utf8");
  if (config.format !== "json") writeTabbedReport(join(staging, "report.html"), {
    title: "doctor Data 业务数据汇集报告", description: "按 Biz ID 独立诊断", ariaLabel: "Biz ID 数据诊断结果", tabs,
  });
  return { status: aggregateCommandStatus(items.map(item => item.status)), output: { items },
    artifacts: [summary, ...items.flatMap(item => item.artifacts)] };
}

function writeDataManifest(
  bundle: EvidenceBundle, config: DataConfig, plugin: PluginDefinition, services: readonly string[],
  facts: Readonly<DataFacts>, startedAt: string,
): void {
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: { namespace: config.namespace, input_ids: config.ids, services },
    inspectionFacts: facts,
    params: { services, inspect_capabilities: Object.fromEntries(services.map(service => {
      const capability = plugin.services.findWithContribution(service, "inspect")!.contributions.inspect;
      return [service, { provides: capability.provides, expands: capability.expands ?? [] }];
    })), output_format: config.format },
    startedAt, finishedAt: new Date().toISOString(),
  });
}

function writeDataEvidence(
  bundle: EvidenceBundle, config: DataConfig, plugin: PluginDefinition, services: readonly string[],
  facts: Readonly<DataFacts>, startedAt: string, diagnosis?: DataDiagnosis, reason?: string,
): void {
  for (const service of services) {
    for (const stage of ["expand", "provide"] as const) {
      const results = facts.capabilityResults.filter(item => item.service === service && item.stage === stage);
      if (results.length) bundle.fill(`data-${stage}-${service}`, {
        status: results.every(item => item.status === "collected") ? "ok" : "partial",
        output: JSON.stringify({ results }, null, 2), ext: "json",
      });
    }
  }
  if (reason) bundle.settle(reason);
  bundle.writeSummary(diagnosis ? buildDataSummary(diagnosis) : `# 业务数据汇集诊断失败\n\n${reason}\n`);
  writeDataManifest(bundle, config, plugin, services, facts, startedAt);
  if (diagnosis) writeFileSync(join(bundle.dir, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
  if (reason) recordFailureBundle({ bundleDir: bundle.dir, collectCode: 1, reason });
  else if (diagnosis && config.format !== "json") writeHtmlReport(bundle.dir, join(bundle.dir, "report.html"), {
    title: "doctor Data 业务数据汇集报告", profileName: config.profileName, summaryHtml: buildDataHtml(diagnosis),
  });
}
