import type { ServiceS3StoreCapability } from "@compforge/doctor-plugin";
import type { Executor } from "../../../infra/k8s/executor";
import type { CommandContext } from "../../../command";
import { terminalStdout } from "../../../terminal/output";
import { runDiagnosis } from "../../engine";
import type { OutcomeDecl } from "../../evidence";
import { runInspects } from "../../inspect-engine";
import { evaluateCollectOutcome } from "../../outcome";
import type { StoreConfig } from "../config";
import { createStoreBundle, deliverStoreBundle, type StoreHtmlReportOptions } from "../delivery";
import type { S3CommandContext } from "./context";
import { buildS3Coverage, s3Detectors } from "./detector";
import { makeS3AccessInspect, makeS3ConfigurationInspect, makeS3ProviderInspect } from "./fact";
import type { S3InspectionFacts } from "./fact/model";
import { groupS3Observations, type S3Diagnosis } from "./model";
import { makeS3Probes } from "./probe";
import { buildS3HtmlReport, buildS3Summary } from "./render";

const S3_OUTCOMES: readonly OutcomeDecl[] = [
  { id: "runtime-config", title: "从 Service Pod 解析 S3 配置（凭据已移除）", risk: "observe" },
  { id: "access-preparation", title: "准备 S3 本机访问通道", risk: "observe" },
  { id: "provider-detection", title: "识别 S3 Provider 能力", risk: "observe" },
  { id: "bucket-access", title: "S3 Bucket 发现与访问检查", risk: "observe" },
  { id: "bucket-usage", title: "Provider Bucket Usage Metrics", risk: "observe" },
  { id: "object-inventory", title: "S3 对象前缀、大小与时间画像", risk: "observe" },
  { id: "provider-health", title: "对象存储 provider 健康检查", risk: "observe" },
  { id: "capacity", title: "对象存储物理容量", risk: "observe" },
  { id: "findings", title: "S3 健康与容量判读", risk: "observe" },
];

export async function runStoreS3(
  config: StoreConfig,
  commandContext: CommandContext,
  executor: Executor,
): Promise<number> {
  const capability = config.capability as ServiceS3StoreCapability;
  const state = createStoreBundle("s3", config.output, config.outputFormat, S3_OUTCOMES);
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  const ctx: S3CommandContext = {
    command: commandContext,
    executor,
    config,
    capability,
    bundle: state.bundle,
    log,
  };
  let facts: S3InspectionFacts | undefined;
  let diagnosis: S3Diagnosis | undefined;

  const finish = async (code: number, summary: string, htmlReport?: StoreHtmlReportOptions) => {
    ctx.forwarder?.stop();
    return deliverStoreBundle({
      state,
      config,
      code,
      summary,
      inspectionFacts: facts ? { ...facts } : {},
      htmlReport,
    });
  };

  try {
    facts = await runInspects([
      makeS3ConfigurationInspect(),
      makeS3AccessInspect(),
      makeS3ProviderInspect(),
    ], ctx, log) as S3InspectionFacts;
    if (facts.configuration.status === "unavailable") {
      return finish(0, [
        "# S3 Store 诊断摘要",
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
      probes: makeS3Probes(),
      log,
      buildEvidence: (observations, inspectionFacts) => ({ observations, facts: inspectionFacts }),
      detectors: s3Detectors,
      buildCoverage: buildS3Coverage,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return finish(1, `# S3 Store 诊断失败\n\n${reason}\n`);
  }

  state.bundle.fill("findings", {
    status: "ok",
    output: `${JSON.stringify(diagnosis.findings, null, 2)}\n`,
    ext: "json",
  });
  const observations = groupS3Observations(diagnosis.evidence.observations);
  const coverage = new Map(diagnosis.coverage.map((item) => [item.goal, item.status]));
  const outcome = evaluateCollectOutcome([
    coverage.get("bucket-access") !== "insufficient",
    coverage.get("capacity") !== "insufficient",
    coverage.get("object-inventory") !== "insufficient",
  ]);
  return finish(
    outcome.exitCode,
    buildS3Summary(config, facts, observations),
    buildS3HtmlReport(observations),
  );
}

export * from "./detector";
export * from "./fact";
export * from "./model";
export * from "./probe";
export { buildS3HtmlReport } from "./render";
