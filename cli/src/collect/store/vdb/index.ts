import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../../app/version";
import type { Executor } from "../../../infra/k8s/executor";
import type { CommandContext } from "../../../command";
import type { SearchEngine } from "../../../infra/search";
import { parseOpenSearchEndpoint } from "../../../infra/search/opensearch";
import { terminalStderr, terminalStdout } from "../../../terminal/output";
import { runCollect } from "../../engine";
import { EvidenceBundle, type OutcomeDecl } from "../../evidence";
import { evaluateCollectOutcome } from "../../outcome";
import { resolveStoreOutputPath, type StoreConfig } from "../config";
import { writeStoreArtifacts } from "../artifacts";
import { vdbConfigFromStore } from "./config";
import type { VdbCommandContext } from "./context";
import { buildVdbCoverage, vdbCapacityConclusion, vdbDetectors } from "./detector";
import { makeVdbAccessInspect, makeVdbConfigurationInspect } from "./fact";
import type { VdbInspectionFacts } from "./fact/model";
import { groupVdbObservations, type VdbDiagnosis } from "./model";
import { makeVdbProbes } from "./probe";
import { buildVdbSummary } from "./render";

const VDB_OUTCOMES: readonly OutcomeDecl[] = [
  { id: "runtime-config", title: "从目标 Container 解析 VDB 运行时配置（凭据已移除）", risk: "observe" },
  { id: "access-preparation", title: "准备 OpenSearch 本机访问通道", risk: "observe" },
  { id: "cluster-health", title: "OpenSearch cluster health", risk: "observe" },
  { id: "node-allocation", title: "OpenSearch data node 磁盘分配", risk: "observe" },
  { id: "cluster-stats", title: "OpenSearch cluster stats", risk: "observe" },
  { id: "shard-state", title: "OpenSearch shard 状态", risk: "observe" },
  { id: "cluster-settings", title: "OpenSearch 实时磁盘水位", risk: "observe" },
  { id: "index-write-blocks", title: "OpenSearch index 写保护状态", risk: "observe" },
  { id: "findings", title: "VDB 健康与容量规则判读", risk: "observe" },
];

export function defaultStoreVdbBundleName(now: Date): string {
  const p = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `doctor-store-vdb-${timestamp}`;
}

function safeEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return parseOpenSearchEndpoint(value).safeEndpoint;
  } catch {
    return undefined;
  }
}

export async function runStoreVdb(
  storeConfig: StoreConfig,
  commandContext: CommandContext,
  executor: Executor,
  injectedSearch?: SearchEngine,
): Promise<number> {
  const config = vdbConfigFromStore(storeConfig);
  const namespace = config.collect.kubernetes.namespace;
  const kube = {
    namespace,
    kubeconfig: config.collect.kubernetes.kubeconfig,
    context: config.collect.kubernetes.context,
  };
  const bundleName = defaultStoreVdbBundleName(new Date());
  const outputPath = resolveStoreOutputPath(config.output, bundleName, storeConfig.outputFormat);
  const staging = join(mkdtempSync(join(tmpdir(), "doctor-store-vdb-")), bundleName);
  commandContext.artifacts.add("vdb", staging);
  const bundle = new EvidenceBundle(staging, VDB_OUTCOMES);
  const startedAt = new Date().toISOString();
  let facts: VdbInspectionFacts | undefined;
  let diagnosis: VdbDiagnosis | undefined;
  const source = config.inspectedTarget?.source;
  const target: Record<string, unknown> = {
    namespace: source?.namespace ?? namespace,
    pod: source?.pod ?? config.target?.pod,
    container: source?.container ?? config.target?.container,
    service: storeConfig.service,
  };
  const log = (line: string) => terminalStdout.write(`${line}\n`);
  const ctx: VdbCommandContext = {
    command: commandContext,
    config,
    executor,
    execTarget: config.target,
    kube,
    bundle,
    search: injectedSearch,
    log,
  };

  const finish = async (code: number, summary: string) => {
    await ctx.preparation?.close();
    bundle.settle(code === 0 ? "本轮未取得该项证据" : "上游步骤失败，未执行");
    bundle.writeSummary(summary);
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target,
      inspectionFacts: facts ? { ...facts } : {},
      params: {
        namespace,
        pod: source?.pod ?? config.target?.pod,
        container: source?.container ?? config.target?.container,
        store: config.store,
        service: config.service,
        endpoint: safeEndpoint(config.endpoint),
        provider_service: storeConfig.service,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    const prepared = await writeStoreArtifacts({
      staging,
      bundleName,
      outputPath,
      requestedOutput: config.output,
      format: storeConfig.outputFormat,
      code,
      title: "doctor VDB Store 诊断报告",
      profileName: config.collect.profileName,
      summary,
    });
    if (!prepared.ok) {
      terminalStderr.error(`[collect] 交付失败，证据保留在目录: ${staging}\n`);
      return 1;
    }
    return code;
  };

  try {
    const execution = await runCollect({
      ctx,
      config,
      inspects: [
        makeVdbConfigurationInspect(config),
        makeVdbAccessInspect(config),
      ],
      checkpointFacts: (collectedFacts) => {
        facts = collectedFacts;
      },
      planProbes: (collectedFacts) => collectedFacts.configuration.status === "unavailable"
        ? []
        : makeVdbProbes(),
      log,
      buildEvidence: (observations, inspectionFacts) => ({
        observations,
        facts: inspectionFacts,
      }),
      detectors: vdbDetectors,
      buildCoverage: buildVdbCoverage,
    });
    facts = execution.facts;
    diagnosis = execution.diagnosis;
    if (facts.configuration.status === "unavailable") {
      const reason = facts.configuration.reason;
      return finish(0, [
        "# VDB Store 诊断摘要",
        "",
        `- Service: \`${storeConfig.service}\``,
        `- Store: \`${storeConfig.capability.id}\``,
        "- 状态: **当前未启用**",
        `- 原因: ${reason}`,
        "",
      ].join("\n"));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return finish(1, `# VDB Store 诊断失败\n\n${reason}\n`);
  }
  const observations = groupVdbObservations(diagnosis.evidence.observations);
  bundle.fill("findings", {
    status: "ok",
    output: `${JSON.stringify(diagnosis.findings, null, 2)}\n`,
    ext: "json",
  });
  const configuration = facts.configuration.status === "collected"
    ? facts.configuration
    : undefined;
  const summary = buildVdbSummary({
    pod: source?.pod ?? config.target?.pod,
    container: source?.container ?? config.target?.container,
    providerService: storeConfig.service,
    store: configuration?.store ?? config.store ?? "unknown",
    source: configuration
      ? `${configuration.configSource}/${configuration.configurationKind}`
      : "unavailable",
    channel: facts.access.status === "collected" ? facts.access.channel : "unavailable",
    observations,
    findings: diagnosis.findings,
    coverage: diagnosis.coverage,
  });
  terminalStdout.write(`[collect] ${vdbCapacityConclusion(observations)}\n`);
  const healthCoverage = diagnosis.coverage.find((item) => item.goal === "cluster-health");
  const capacityCoverage = diagnosis.coverage.find((item) => item.goal === "capacity");
  const outcome = evaluateCollectOutcome([
    healthCoverage?.status === "sufficient",
    capacityCoverage?.status !== "insufficient",
  ]);
  return finish(outcome.exitCode, summary);
}

export * from "./configuration";
export * from "./detector";
export * from "./fact";
export * from "./model";
export * from "./probe";
export * from "./render";
