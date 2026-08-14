import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ModelCatalog,
  ModelInference,
} from "@compforge/doctor-plugin";
import type { TenantSummary } from "@compforge/doctor-plugin";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { runDiagnosis } from "../engine";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { runInspects } from "../inspect-engine";
import { evaluateCollectOutcome } from "../outcome";
import { writeHtmlReport } from "../output/html";
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
  ModelFinding,
  ModelInspectionFacts,
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
import { buildModelDiagnosisHtml, buildModelMarkdown } from "./render";

export interface RunModelDiagnosisInput {
  tenant: TenantSummary;
  model: SelectedInferenceModel;
  catalog: ModelCatalog;
  inference: ModelInference;
  performance?: boolean;
  repeat: number;
  timeoutMs: number;
  maxOutputTokens: number;
  output?: string;
  profileName: string;
}

export interface RunModelDiagnosisResult {
  exitCode: number;
  outputPath?: string;
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
  now = new Date(),
): string {
  const candidate = output?.trim() || `doctor-model-${timestamp(now)}.html`;
  return resolve(candidate.toLowerCase().endsWith(".html") ? candidate : `${candidate}.html`);
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

function printResponse(
  label: string,
  diagnosis: ModelDiagnosis,
  kind: "model-validation" | "model-inference",
): void {
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
  // Validation bodies are backend metadata already preserved in Evidence; printing them here
  // leaves users with context-free payloads such as { "parameters": null }.
  if (kind === "model-validation") return;
  const trimmed = response.text.trim();
  if (!trimmed) {
    terminalStdout.write("(empty response body)\n");
    return;
  }
  try {
    terminalStdout.write(`${JSON.stringify(JSON.parse(trimmed), null, 2)}\n`);
  } catch {
    terminalStdout.write(`${trimmed}\n`);
  }
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
  const staging = join(stagingRoot, "evidence");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const bundle = new EvidenceBundle(staging, modelOutcomes());
  const ctx = {
    catalog: input.catalog,
    inference: input.inference,
    bundle,
    staging,
    log: (line: string) => terminalStderr.info(`${line}\n`),
  };
  let facts!: Readonly<ModelInspectionFacts>;
  let diagnosis!: ModelDiagnosis;

  try {
    facts = await runInspects(
      [makeModelInspect(input.tenant, input.model)],
      ctx,
      (line) => terminalStdout.write(`${line}\n`),
    );
    bundle.fill("model-inspect", {
      status: facts.backend.status === "collected" ? "ok" : facts.backend.status,
      reason: facts.backend.status === "collected" ? undefined : facts.backend.reason,
      output: `${JSON.stringify(facts, null, 2)}\n`,
      ext: "json",
    });

    diagnosis = await runDiagnosis({
      ctx,
      facts,
      config,
      probes: makeModelProbes(input.model),
      log: (line) => terminalStdout.write(`${line}\n`),
      buildEvidence: buildModelEvidence,
      detectors: modelDetectors,
      buildCoverage: buildModelCoverage(config),
    });
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
    writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify({
      observations: diagnosis.evidence.observations,
      summaries,
      findings: serializeFindings(diagnosis.findings),
      coverage: diagnosis.coverage,
    }, null, 2)}\n`, { mode: 0o600 });
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

    const outputPath = performanceEnabled || input.performance === true || input.output
      ? resolveModelDiagnosisOutput(input.output, startedAt)
      : undefined;
    if (outputPath) {
      writeHtmlReport(staging, outputPath, {
        title: "doctor model 诊断报告",
        profileName: input.profileName,
        summaryHtml: buildModelDiagnosisHtml(
          diagnosis,
          summaries,
          attempts,
        ),
      });
      chmodSync(outputPath, 0o600);
      terminalStdout.success(`[model] 诊断报告：${outputPath}\n`);
    }

    printResponse("validation", diagnosis, "model-validation");
    printResponse("inference", diagnosis, "model-inference");
    printFindings(diagnosis.findings);
    const outcome = evaluateCollectOutcome(
      diagnosis.coverage.map((item) => item.status === "sufficient"),
    );
    rmSync(stagingRoot, { recursive: true, force: true });
    return {
      exitCode: outcome.exitCode,
      outputPath,
      diagnosis,
      attempts,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.settle(reason);
    terminalStderr.error(`[model] 诊断流程失败：${reason}；原始数据保留在 ${staging}\n`);
    throw error;
  }
}
