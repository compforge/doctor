import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ModelCatalog,
  ModelInference,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import type { TenantSummary } from "@compforge/doctor-plugin";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runCollect } from "../engine";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { evaluateCollectOutcome } from "../outcome";
import { writeHtmlReport } from "../output/html";
import { recordFailureBundle } from "../output/failure-bundle";
import {
  buildModelCoverage,
  buildModelEvidence,
  modelDetectors,
  modelPerformanceDecision,
  modelPerformanceAttempts,
  modelPerformanceSummaries,
  modelResponseObservation,
} from "./detector";
import { makeModelInspect } from "./fact/inspect";
import type {
  ModelDiagnosis,
  ModelDiagnosisConfig,
  ModelCommandContext,
  ModelFinding,
  ModelInspectionFacts,
  ModelOutputFormat,
  SelectedInferenceModel,
} from "./model";
import type { ModelPerformanceAttempt } from "./performance";
import {
  makeModelProbes,
  MODEL_PERFORMANCE_DECISION_PROBE_ID,
  MODEL_PERFORMANCE_PROBE_ID,
  MODEL_INFERENCE_PROBE_ID,
  MODEL_VALIDATION_PROBE_ID,
} from "./probe";
import {
  buildModelDiagnosisHtml,
  buildModelMarkdown,
  buildModelPerformanceTerminalSummary,
} from "./render";

export interface RunModelDiagnosisInput {
  command: CommandContext;
  tenant: TenantSummary;
  model: SelectedInferenceModel;
  catalog: ModelCatalog;
  inference: ModelInference;
  performance?: boolean;
  repeat: number;
  timeoutMs: number;
  maxOutputTokens: number;
  format: ModelOutputFormat;
  output?: string;
  profileName: string;
}

export interface RunModelDiagnosisResult {
  exitCode: number;
  diagnosis: ModelDiagnosis;
  attempts: readonly ModelPerformanceAttempt[];
}

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

export function resolveModelDiagnosisOutput(
  output: string | undefined,
  format: ModelOutputFormat,
  now = new Date(),
): string {
  const suffix = `.${format}`;
  const candidate = output?.trim() || `doctor-model-${timestamp(now)}${suffix}`;
  return resolve(candidate.toLowerCase().endsWith(suffix) ? candidate : `${candidate}${suffix}`);
}

function modelOutcomes(): OutcomeDecl[] {
  return [
    { id: "model-inspect", title: "模型目录与 backend 配置", risk: "observe" },
    { id: MODEL_VALIDATION_PROBE_ID, title: "Model validation", risk: "overhead" },
    {
      id: MODEL_PERFORMANCE_DECISION_PROBE_ID,
      title: "模型性能测试选择",
      risk: "observe",
    },
    { id: MODEL_INFERENCE_PROBE_ID, title: "Model inference", risk: "overhead" },
    { id: MODEL_PERFORMANCE_PROBE_ID, title: "LLM 流式性能采样", risk: "overhead" },
    { id: "model-findings", title: "Model Detector Findings", risk: "observe" },
  ];
}

function serializeFindings(findings: readonly ModelFinding[]) {
  return findings.map((finding) => ({
    ...finding,
    evidence: finding.evidence,
  }));
}

function printResponseStatus(
  label: string,
  diagnosis: ModelDiagnosis,
  kind: "model-validation" | "model-inference",
): void {
  // Response bodies stay in Diagnosis reports; the terminal only shows request status.
  const observation = modelResponseObservation(diagnosis.evidence, kind);
  if (!observation) return;
  if (observation.error) {
    terminalStderr.error(`[model] ${label}: ${observation.error}\n`);
    return;
  }
  const response = observation.response!;
  terminalStdout.result(
    response.ok,
    `[model] ${label}: HTTP ${response.statusCode} ${response.statusText} (${response.durationMs}ms)\n`,
  );
}

function printFindings(findings: readonly ModelFinding[]): void {
  for (const finding of findings) {
    const line = `[model] ${finding.kind}: ${finding.summary}\n`;
    if (finding.severity === "critical") terminalStderr.error(line);
    else if (finding.severity === "warning") terminalStderr.warning(line);
    else terminalStderr.info(line);
  }
}

export async function runModelDiagnosis(
  input: RunModelDiagnosisInput,
): Promise<RunModelDiagnosisResult> {
  const startedAt = new Date();
  const config: ModelDiagnosisConfig = {
    performance: input.performance,
    repeat: input.repeat,
    maxOutputTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
  };
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-model-diagnosis-"));
  const staging = join(stagingRoot, `doctor-model-${timestamp(startedAt)}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  input.command.artifacts.add("model", staging);
  const bundle = new EvidenceBundle(staging, modelOutcomes());
  const ctx: ModelCommandContext = {
    command: input.command,
    config,
    catalog: input.catalog,
    inference: input.inference,
    bundle,
    staging,
    log: (line: string) => terminalStderr.info(`${line}\n`),
  };
  let facts!: Readonly<ModelInspectionFacts>;
  let diagnosis!: ModelDiagnosis;

  try {
    const execution = await runCollect({
      ctx,
      config,
      inspects: [makeModelInspect(input.tenant, input.model)],
      checkpointFacts: (collectedFacts) => {
        bundle.fill("model-inspect", {
          status: collectedFacts.backend.status === "collected" ? "ok" : collectedFacts.backend.status,
          reason: collectedFacts.backend.status === "collected" ? undefined : collectedFacts.backend.reason,
          output: `${JSON.stringify(collectedFacts, null, 2)}\n`,
          ext: "json",
        });
      },
      planProbes: () => makeModelProbes(input.model),
      log: (line) => terminalStdout.write(`${line}\n`),
      buildEvidence: buildModelEvidence,
      detectors: modelDetectors,
      buildCoverage: buildModelCoverage(config),
    });
    facts = execution.facts;
    diagnosis = execution.diagnosis;
    bundle.fill("model-findings", {
      status: "ok",
      output: `${JSON.stringify({
        findings: serializeFindings(diagnosis.findings),
        coverage: diagnosis.coverage,
      }, null, 2)}\n`,
      ext: "json",
    });

    const attempts = modelPerformanceAttempts(diagnosis.evidence);
    const summaries = modelPerformanceSummaries(diagnosis.evidence);
    const performanceEnabled = modelPerformanceDecision(diagnosis.evidence)?.enabled ?? false;
    bundle.writeSummary(buildModelMarkdown(diagnosis, summaries, attempts));
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: facts.target.status === "collected" ? { ...facts.target } : {
        model: input.model.id,
        tenant: input.tenant.id,
      },
      inspectionFacts: { ...facts },
      params: {
        performance_requested: config.performance,
        performance_enabled: performanceEnabled,
        repeat: config.repeat,
        max_output_tokens: config.maxOutputTokens,
        timeout_ms: config.timeoutMs,
      },
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    });

    writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, { mode: 0o600 });
    if (input.format !== "json") {
      writeHtmlReport(staging, join(staging, "report.html"), {
        title: "doctor model 诊断报告",
        profileName: input.profileName,
        summaryHtml: buildModelDiagnosisHtml(diagnosis, summaries, attempts),
      });
    }

    printResponseStatus("validation", diagnosis, "model-validation");
    printResponseStatus("inference", diagnosis, "model-inference");
    for (const line of buildModelPerformanceTerminalSummary(summaries)) {
      terminalStdout.info(line);
    }
    printFindings(diagnosis.findings);
    const outcome = evaluateCollectOutcome(
      diagnosis.coverage.map((item) => item.status === "sufficient"),
    );
    if (outcome.exitCode !== 0) {
      recordFailureBundle({ bundleDir: staging, collectCode: outcome.exitCode });
    }
    return {
      exitCode: outcome.exitCode,
      diagnosis,
      attempts,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.settle(reason);
    recordFailureBundle({ bundleDir: staging, collectCode: 1, reason });
    terminalStderr.error(`[model] 诊断流程失败：${reason}；原始数据保留在 ${staging}\n`);
    throw error;
  }
}
