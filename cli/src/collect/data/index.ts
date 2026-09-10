import { projectDataFacts } from "./projection";
import { CommandStatus, aggregateCommandStatus, commandOutcome, type CommandResult } from "../../command";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../../app/error-log";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginContext, PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/doctor-toolkit/kubernetes/executor";
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
import { prepareDataCommand, type PreparedDataCommand, type DataCommandContext } from "./context";
import { makeDataInspect } from "./fact/inspect";
import type {
  CollectDataCliOpts,
  DataDiagnosis,
  DataOutput,
  DataServiceSelection,
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
  prepared?: { command: PreparedDataCommand; selections: DataServiceSelection[]; facts: DataFacts };
  onCollected?: (prepared: { command: PreparedDataCommand; selections: DataServiceSelection[]; facts: DataFacts }) => Promise<CommandResult<void | DataOutput>>;
}

async function runCollectDataSingle(
  opts: CollectDataCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedExecutor?: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
  hooks: DataSingleRunHooks = {},
): Promise<CommandResult<void | DataOutput>> {
  const startedAt = new Date().toISOString();
  let dataCommand;
  try {
    dataCommand = hooks.prepared?.command ?? await prepareDataCommand(
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
  const config = hooks.prepared ? { ...dataCommand.config, ids: opts.bizIds ?? [], reportName: opts.reportName ?? dataCommand.config.reportName, format: parseDataOutputFormat(opts.format) } : dataCommand.config;
  terminalStdout.write(`[collect] namespace: ${config.namespace}（${config.namespaceSource}）\n`);
  let selections;
  try {
    selections = hooks.prepared?.selections ?? await resolveDataServiceSelection({ config, catalog: plugin.services });
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
  if (!hooks.onCollected) commandContext.artifacts.add({ command: "data", path: staging });
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
    if (hooks.prepared) {
      facts = hooks.prepared.facts;
      for (const selection of selections) {
        for (const stage of ["expand", "provide"] as const) {
          const results = facts.capabilityResults.filter(item => item.service === selection.service && item.stage === stage);
          if (!results.length) continue;
          bundle.fill(`data-${stage}-${selection.service}`, { status: results.every(item => item.status === "collected") ? "ok" : "partial",
            output: JSON.stringify({ results }, null, 2), ext: "json" });
        }
      }
      // Reuse the frozen acquisition facts through the same engine; projection never performs external work.
      const projected = facts;
      const execution = await runCollect({ ctx: undefined, config,
        inspects: [
          { id: "data-service-targets", run: async () => ({ services: projected.services }) },
          { id: "data-service-contributions", dependsOn: ["data-service-targets"], run: async () => ({ capabilityResults: projected.capabilityResults }) },
        ], planProbes: () => [], log,
        buildEvidence: buildDataEvidence, detectors: makeDataDetectors(plugin.id, plugin.services, selections.map(item => item.service)),
        buildCoverage: buildDataCoverage });
      diagnosis = execution.diagnosis;
    } else {
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
        detectors: hooks.onCollected ? [] : makeDataDetectors(plugin.id, plugin.services, selections.map((selection) => selection.service)),
        buildCoverage: buildDataCoverage,
      });
      facts = execution.facts;
      diagnosis = execution.diagnosis;
    }
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

  if (hooks.onCollected) {
    try { return await hooks.onCollected({ command: dataCommand, selections, facts }); }
    finally { rmSync(stagingRoot, { recursive: true, force: true }); }
  }

  const requirements = selections.map((selection) => (
    diagnosis.evidence.facts.capabilityResults.some((item) => (
      item.status === "collected"
      && item.service === selection.service
      && item.result.resolution.resolvedAs !== "unresolved"
    ))
  ));
  const outcome = evaluateCollectOutcome(requirements);
  hooks.onDiagnosis?.(diagnosis);
  if (outcome.exitCode !== 0) {
    const reason = diagnosis.coverage[0]?.missingEvidence.join("；") || "未取得所选 Service 的业务记录";
    return commandOutcome(await fail(reason));
  }

  bundle.writeSummary(buildDataSummary(diagnosis));
  writeManifest();
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

/** Collect the identity closure once, then diagnose and deliver each input projection independently. */
export async function runCollectData(
  opts: CollectDataCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedExecutor?: Executor,
  injectedContexts?: Readonly<Record<string, PluginContext>>,
): Promise<CommandResult<void | DataOutput>> {
  const ids = [...new Set([
    ...(opts.bizIds ?? []),
    ...(opts.bizId ? [opts.bizId] : []),
  ].map((item) => item.trim()).filter(Boolean))];
  if (!ids.length) {
    terminalStderr.error("doctor data 需要至少一个 biz-id\n");
    return commandOutcome(2);
  }
  if (ids.length === 1) {
    let diagnosis: DataDiagnosis | undefined;
    const child = await commandContext.artifacts.capture(() => runCollectDataSingle(
      { ...opts, bizIds: ids }, plugin, commandContext, injectedExecutor, injectedContexts,
      { onDiagnosis: value => { diagnosis = value; } },
    ));
    commandContext.artifacts.add(child.artifacts);
    return { ...child.value, artifacts: child.artifacts, output: { items: [{ bizId: ids[0]!,
      status: child.value.status, artifacts: child.artifacts, diagnosis,
      ...("reason" in child.value ? { reason: child.value.reason } : {}) }] } };
  }

  return runCollectDataSingle({ ...opts, bizIds: ids }, plugin, commandContext, injectedExecutor, injectedContexts, {
    onCollected: async prepared => {
      const format = parseDataOutputFormat(opts.format);
      const batchName = dataReportName(new Date());
      const staging = join(mkdtempSync(join(tmpdir(), "doctor-data-batch-")), batchName);
      mkdirSync(staging, { recursive: true });
      commandContext.artifacts.add({ command: "data", path: staging });
      const items: DataOutput["items"][number][] = [];
      const groups: Record<string, DataDiagnosis | { error: string }> = {};
      const tabs = [];
      for (const [index, bizId] of ids.entries()) {
        terminalStdout.warning(`\n[collect:data] [${index + 1}/${ids.length}] biz-id: ${bizId}\n`);
        let diagnosis: DataDiagnosis | undefined;
        const child = await commandContext.artifacts.capture(() => runCollectDataSingle({ ...opts, bizIds: [bizId],
          format: format === "json" ? "json" : "html", reportName: `${batchName}-biz-${index + 1}`,
        }, plugin, commandContext, injectedExecutor, injectedContexts, {
          prepared: { ...prepared, facts: projectDataFacts(prepared.facts, bizId) },
          onDiagnosis: value => { diagnosis = value; },
        }));
        commandContext.artifacts.add(child.artifacts);
        const result = child.value;
        items.push({ bizId, status: result.status, artifacts: child.artifacts, diagnosis,
          ...("reason" in result ? { reason: result.reason } : {}) });
        groups[bizId] = diagnosis ?? { error: `采集未完成（${result.status}）` };
        const htmlPath = child.artifacts[0] ? join(child.artifacts[0].path, "report.html") : "";
        tabs.push({ key: `biz-${index + 1}`, label: bizId,
          status: existsSync(htmlPath) ? "delivered" as const : "failed" as const,
          html: existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : failedReportHtml(`Data 诊断失败：${bizId}`, `采集状态 ${result.status}`) });
      }
      writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify({ groups }, null, 2)}\n`, "utf8");
      if (format !== "json") writeTabbedReport(join(staging, "report.html"), {
        title: "doctor Data 业务数据汇集报告", description: "批量采集，每个 Biz ID 独立诊断", ariaLabel: "Biz ID 数据诊断结果", tabs,
      });
      return { status: aggregateCommandStatus(items.map(item => item.status)), output: { items }, artifacts: commandContext.artifacts.list() };
    },
  });
}
