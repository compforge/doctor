import type { ServiceDatabaseDataSource } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { commandOutcome, type CommandResult, type CommandStatus, type CommandContext } from "../../../command";

import { useLogger } from "../../../terminal/log";
import { runCollect } from "../../engine";
import type { OutcomeDecl } from "../../evidence";
import { collectCommandOutcome, evaluateCollectOutcome } from "../../outcome";
import type { StoreConfig } from "../config";
import { createStoreBundle, finishStoreBundle } from "../artifacts";
import type { DbCommandContext } from "./context";
import { detectDbEvidenceGaps, dbDetectors } from "./detector";
import { makeDbAccessInspect, makeDbConfigurationInspect } from "./fact";
import type { DbInspectionFacts } from "./fact/model";
import { groupDbObservations, type DbDiagnosis } from "./model";
import { makeDbProbes } from "./probe";
import { buildDbSummary } from "./render";

const DB_OUTCOMES: readonly OutcomeDecl[] = [
  { id: "runtime-config", title: "从 Service Pod 解析 DB 配置（凭据已移除）", risk: "observe" },
  { id: "access-preparation", title: "准备 DB 本机访问通道", risk: "observe" },
  { id: "health", title: "DB 连通性与只读查询健康检查", risk: "observe" },
  { id: "server-info", title: "DB 版本、角色与连接上限", risk: "observe" },
  { id: "capacity", title: "DB schema 逻辑容量与 Top 表", risk: "observe" },
  { id: "load", title: "DB 5 秒负载增量与连接饱和度", risk: "observe" },
  { id: "lock-waits", title: "DB 活跃事务与锁等待", risk: "observe" },
  { id: "findings", title: "DB 健康、容量与负载判读", risk: "observe" },
];

export async function runStoreDb(
  config: StoreConfig,
  commandContext: CommandContext,
  executor: Executor,
): Promise<CommandResult<void>> {
  const capability = config.capability as ServiceDatabaseDataSource;
  const state = createStoreBundle("db", config.output, config.outputFormat, DB_OUTCOMES, commandContext);
  const log = (line: string) => useLogger().info(`${line}`);
  const ctx: DbCommandContext = {
    command: commandContext,
    executor,
    config,
    capability,
    bundle: state.bundle,
    log,
  };
  let facts: DbInspectionFacts | undefined;
  let diagnosis: DbDiagnosis | undefined;

  const finish = async (code: number, summary: string, status?: CommandStatus) => {
    return finishStoreBundle({
      state,
      config,
      code,
      status,
      summary,
      inspectionFacts: facts ? { ...facts } : {},
    });
  };

  try {
    const execution = await runCollect({
      ctx,
      config,
      inspects: [
        makeDbConfigurationInspect(),
        makeDbAccessInspect(),
      ],
      checkpointFacts: (collectedFacts) => {
        facts = collectedFacts;
      },
      planProbes: (collectedFacts) => collectedFacts.configuration.status === "unavailable"
        ? []
        : makeDbProbes(),
      log,
      buildEvidence: (observations, inspectionFacts) => ({ observations, facts: inspectionFacts }),
      detectors: [...dbDetectors, detectDbEvidenceGaps],

    });
    facts = execution.facts;
    diagnosis = execution.diagnosis;
    if (facts.configuration.status === "unavailable") {
      return finish(0, [
        "# DB Store 诊断摘要",
        "",
        `- Service: \`${config.service}\``,
        `- Store: \`${capability.id}\``,
        "- 状态: **当前未启用**",
        `- 原因: ${facts.configuration.reason}`,
        "",
      ].join("\n"));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return finish(1, `# DB Store 诊断失败\n\n${reason}\n`);
  }

  state.bundle.fill("findings", {
    status: "ok",
    output: `${JSON.stringify(diagnosis.findings, null, 2)}\n`,
    ext: "json",
  });
  const observations = groupDbObservations(diagnosis.evidence.observations);
  const outcome = evaluateCollectOutcome(state.bundle.getOutcomes().filter(item => item.id !== "findings").map(item => item.status));
  return finish(outcome.exitCode, buildDbSummary(config, facts, observations, diagnosis.findings), collectCommandOutcome(outcome).status);
}

export * from "./detector";
export * from "./fact";
export * from "./model";
export * from "./probe";
