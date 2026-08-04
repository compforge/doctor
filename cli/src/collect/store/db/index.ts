import type { ServiceDatabaseStoreCapability } from "@compforge/doctor-plugin";
import type { Executor } from "../../../infra/k8s/executor";
import { terminalStdout } from "../../../terminal/output";
import { runDiagnosis } from "../../engine";
import type { OutcomeDecl } from "../../evidence";
import { runInspects } from "../../inspect-engine";
import { evaluateCollectOutcome } from "../../outcome";
import type { StoreConfig } from "../config";
import { createStoreBundle, deliverStoreBundle } from "../delivery";
import type { DbCollectContext } from "./context";
import { buildDbCoverage, dbDetectors } from "./detector";
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

export async function runStoreDb(config: StoreConfig, executor: Executor): Promise<number> {
  const capability = config.capability as ServiceDatabaseStoreCapability;
  const state = createStoreBundle("db", config.output, config.outputFormat, DB_OUTCOMES);
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  const ctx: DbCollectContext = { executor, config, capability, bundle: state.bundle, log };
  let facts: DbInspectionFacts | undefined;
  let diagnosis: DbDiagnosis | undefined;

  const finish = async (code: number, summary: string) => {
    await ctx.database?.close();
    ctx.forwarder?.stop();
    return deliverStoreBundle({
      state,
      config,
      code,
      summary,
      inspectionFacts: facts ? { ...facts } : {},
    });
  };

  try {
    facts = await runInspects([
      makeDbConfigurationInspect(),
      makeDbAccessInspect(),
    ], ctx, log) as DbInspectionFacts;
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
    diagnosis = await runDiagnosis({
      ctx,
      facts,
      config,
      probes: makeDbProbes(),
      log,
      buildEvidence: (observations, inspectionFacts) => ({ observations, facts: inspectionFacts }),
      detectors: dbDetectors,
      buildCoverage: buildDbCoverage,
    });
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
  const coverage = new Map(diagnosis.coverage.map((item) => [item.goal, item.status]));
  const outcome = evaluateCollectOutcome([
    coverage.get("health") === "sufficient",
    coverage.get("capacity") === "sufficient",
    coverage.get("load") === "sufficient",
  ]);
  return finish(outcome.exitCode, buildDbSummary(config, facts, observations));
}

export * from "./detector";
export * from "./fact";
export * from "./model";
export * from "./probe";
