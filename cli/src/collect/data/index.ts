import { CommandStatus, aggregateCommandStatus, commandOutcome, type CommandResult } from "../../command";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "../../infra/k8s/executor";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runCollect } from "../engine";
import type { CommandContext } from "../../command";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { evaluateCollectOutcome, collectCommandOutcome } from "../outcome";
import { recordFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import { failedReportHtml, writeTabbedReport } from "../output/tabbed-report";
import {
  dataReportName,
  parseDataOutputFormat,
  resolveDataServiceSelection,
} from "./config";
import { buildDataCoverage, buildDataEvidence, makeDataDetectors } from "./detector";
import { makeDataContributionInspect } from "./capability/collect";
import { prepareDataCommand, type DataCommandContext } from "./context";
import { makeDataInspect } from "./fact/inspect";
import type {
  CollectDataCliOpts,
  DataDiagnosis,
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

/** commander 入口编排 Service Capability、Inspect/Probe、Detector 与最终交付。 */
interface DataSingleRunHooks {
  onDiagnosis?: (diagnosis: DataDiagnosis) => void;
  suppressJson?: boolean;
}

async function runCollectDataSingle(
  opts: CollectDataCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedExecutor?: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
  hooks: DataSingleRunHooks = {},
): Promise<CommandResult<void>> {
  const startedAt = new Date().toISOString();
  let dataCommand;
  try {
    dataCommand = await prepareDataCommand(
      opts,
      plugin.services,
      commandContext,
      injectedExecutor,
    );
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return commandOutcome(2);
  }
  if (!dataCommand) {
    terminalStderr.warning("[collect] 已取消\n");
    return commandOutcome(130);
  }
  const { config } = dataCommand;
  terminalStdout.write(`[collect] namespace: ${config.namespace}（${config.namespaceSource}）\n`);
  let selections;
  try {
    selections = await resolveDataServiceSelection({ config, catalog: plugin.services });
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return commandOutcome(2);
  }
  if (!selections) {
    terminalStderr.warning("[collect] 已取消\n");
    return commandOutcome(130);
  }
  for (const { service } of selections) {
    const capability = plugin.services.findWithContribution(service, "inspect")!.contributions.inspect;
    terminalStdout.write(
      `[collect] Inspect contribution: ${service}（provides=${capability.provides.join(",")}`
      + `${capability.expands?.length ? `；expands=${capability.expands.join(",")}` : ""}）\n`,
    );
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-data-"));
  const staging = join(stagingRoot, config.reportName);
  commandContext.artifacts.add("data", staging);
  const bundle = new EvidenceBundle(
    staging,
    dataOutcomes(selections.map((item) => item.service), plugin),
  );
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  let access: DataAccessPreparation | undefined;
  let facts: DataFacts = { services: {}, capabilityResults: [] };
  let diagnosis: DataDiagnosis | undefined;
  let diagnosisFailure: string | undefined;

  const writeManifest = () => bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: {
      namespace: config.namespace,
      input_ids: config.ids,
      services: selections.map((item) => item.service),
    },
    inspectionFacts: {
      services: facts.services,
      capabilityResults: facts.capabilityResults,
    },
    params: {
      services: selections.map((item) => item.service),
      inspect_capabilities: Object.fromEntries(selections.map(({ service }) => {
        const capability = plugin.services.findWithContribution(service, "inspect")!.contributions.inspect;
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
    recordFailureBundle({
      bundleDir: staging,
      collectCode: 1,
      reason,
    });
    return 1;
  };

  try {
    access = await prepareDataAccess(
      dataCommand,
      selections,
      plugin.services,
      injectedContexts,
    );
    const pluginContexts = Object.fromEntries(
      access.confirmed.flatMap((item) => item.context ? [[item.service, item.context]] : []),
    );
    const ctx: DataCommandContext = { ...dataCommand, pluginContexts, bundle, log };
    const execution = await runCollect({
      ctx,
      config,
      inspects: [
        makeDataInspect(access),
        makeDataContributionInspect({ selections, catalog: plugin.services, config }),
      ],
      planProbes: () => [],
      log,
      buildEvidence: buildDataEvidence,
      detectors: makeDataDetectors(plugin.id, plugin.services, selections.map((selection) => selection.service)),
      buildCoverage: buildDataCoverage,
    });
    facts = execution.facts;
    diagnosis = execution.diagnosis;
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
  if (diagnosisFailure || !diagnosis) return commandOutcome(await fail(diagnosisFailure ?? "Data 诊断未形成结果"));

  const requirements = selections.map((selection) => (
    diagnosis.evidence.facts.capabilityResults.some((item) => (
      item.status === "collected"
      && item.service === selection.service
      && item.result.resolution.resolvedAs !== "unresolved"
    ))
  ));
  const outcome = evaluateCollectOutcome(requirements);
  if (outcome.exitCode !== 0) {
    const reason = diagnosis.coverage[0]?.missingEvidence.join("；") || "未取得所选 Service 的业务记录";
    return commandOutcome(await fail(reason));
  }

  bundle.writeSummary(buildDataSummary(diagnosis));
  writeManifest();
  hooks.onDiagnosis?.(diagnosis);
  writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
  if (config.format === "json") {
    return collectCommandOutcome(outcome);
  }
  const reportPath = join(staging, "report.html");
  try {
    writeHtmlReport(staging, reportPath, {
      title: "doctor Data 业务数据汇集报告",
      profileName: config.profileName,
      summaryHtml: buildDataHtml(diagnosis),
    });
  } catch (error) {
    reportError(error, { context: "doctor data/html-report", summary: "HTML 报告生成失败" });
    return commandOutcome(await fail(error instanceof Error ? error.message : String(error)));
  }
  return collectCommandOutcome(outcome);
}

/** Batch wrapper: each biz-id runs an independent diagnosis; only the final delivery is grouped. */
export async function runCollectData(
  opts: CollectDataCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedExecutor?: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<CommandResult<void>> {
  const ids = [...new Set([
    ...(opts.bizIds ?? []),
    ...(opts.bizId ? [opts.bizId] : []),
  ].map((item) => item.trim()).filter(Boolean))];
  if (!ids.length) {
    terminalStderr.error("doctor data 需要至少一个 biz-id\n");
    return commandOutcome(2);
  }
  if (ids.length === 1) {
    return runCollectDataSingle(
      { ...opts, bizIds: ids },
      plugin,
      commandContext,
      injectedExecutor,
      injectedContexts,
    );
  }

  let format;
  try {
    format = parseDataOutputFormat(opts.format);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return commandOutcome(2);
  }
  const batchName = dataReportName(new Date());
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-data-batch-"));
  const staging = join(stagingRoot, batchName);
  mkdirSync(staging, { recursive: true });
  commandContext.artifacts.add("data", staging);
  if (format === "json") {
    const groups: Record<string, DataDiagnosis | { error: string }> = {};
    const statuses: CommandStatus[] = [];
    for (const [index, bizId] of ids.entries()) {
      if (commandContext.signal.aborted) { statuses.push(CommandStatus.Cancelled); break; }
      let captured: DataDiagnosis | undefined;
      const child = await commandContext.artifacts.capture(() => runCollectDataSingle(
        {
          ...opts,
          bizIds: [bizId],
          format: "json",
          output: undefined,
          reportName: `${batchName}-biz-${index + 1}`,
        },
        plugin,
        commandContext,
        injectedExecutor,
        injectedContexts,
        { onDiagnosis: (diagnosis) => { captured = diagnosis; }, suppressJson: true },
      ));
      commandContext.artifacts.include(child.artifacts);
      const result = child.value;
      groups[bizId] = captured ?? { error: `采集未完成（${result.status}）` };
      statuses.push(result.status);
      if (result.status === CommandStatus.Cancelled) break;
    }
    writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify({ groups }, null, 2)}\n`, "utf8");
    return { status: aggregateCommandStatus(statuses), output: undefined, artifacts: commandContext.artifacts.list() };
  }

  const tabs = [];
  const groups: Record<string, DataDiagnosis | { error: string }> = {};
  const statuses: CommandStatus[] = [];
  for (const [index, bizId] of ids.entries()) {
    if (commandContext.signal.aborted) { statuses.push(CommandStatus.Cancelled); break; }
    let captured: DataDiagnosis | undefined;
    const child = await commandContext.artifacts.capture(() => runCollectDataSingle(
      {
        ...opts,
        bizIds: [bizId],
        format: "html",
        reportName: `${batchName}-biz-${index + 1}`,
      },
      plugin,
      commandContext,
      injectedExecutor,
      injectedContexts,
      { onDiagnosis: (diagnosis) => { captured = diagnosis; } },
    ));
    commandContext.artifacts.include(child.artifacts);
    const result = child.value;
    const childArtifact = child.artifacts[0];
    const htmlPath = childArtifact ? join(childArtifact.path, "report.html") : "";
    groups[bizId] = captured ?? { error: `采集未完成（${result.status}）` };
    tabs.push({
      key: `biz-${index + 1}`,
      label: bizId,
      status: (result.status === CommandStatus.Ok || result.status === CommandStatus.Partial) && existsSync(htmlPath) ? "delivered" as const : "failed" as const,
      html: (result.status === CommandStatus.Ok || result.status === CommandStatus.Partial) && existsSync(htmlPath)
        ? readFileSync(htmlPath, "utf8")
        : failedReportHtml(`Data 诊断失败：${bizId}`, `采集状态 ${result.status}`),
    });
    statuses.push(result.status);
    if (result.status === CommandStatus.Cancelled) break;
  }
  writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify({ groups }, null, 2)}\n`, "utf8");
  writeTabbedReport(join(staging, "report.html"), {
    title: "doctor Data 业务数据汇集报告",
    description: "同一批次采集，每个 Biz ID 独立诊断",
    ariaLabel: "Biz ID 数据诊断结果",
    tabs,
  });
  return { status: aggregateCommandStatus(statuses), output: undefined, artifacts: commandContext.artifacts.list() };
}
