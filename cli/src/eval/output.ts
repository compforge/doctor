import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseSetToRaw, type CaseSet } from "@compforge/spec-case/model";
import { DOCTOR_CLI_VERSION } from "../app/version";
import { buildHtmlReport } from "../collect/output/report/shell";
import { escapeHtml } from "../collect/output/report/components/content";
import { htmlTable } from "../collect/output/report/components/table";
import type { EvalConfig, EvalEvidenceResult, EvalRun } from "./model";

export interface EvalArtifact {
  path: string;
  temporaryRoot: string;
}

export function createEvalArtifact(config: EvalConfig): EvalArtifact {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "doctor-eval-"));
  const path = join(temporaryRoot, config.bundleName);
  mkdirSync(path, { recursive: true });
  return { path, temporaryRoot };
}

function evidenceLabel(result: EvalEvidenceResult): string {
  if (result.status === "collected") return "collected";
  return result.reason ? `${result.status}: ${result.reason}` : result.status;
}

function writeEvalReport(path: string, run: EvalRun, profileName: string): void {
  const successful = run.cases.filter((item) => item.protocol?.ok).length;
  const correlated = run.cases.filter((item) => item.correlation).length;
  const summaryHtml = `<h1>执行摘要</h1><p>CaseSet <code>${escapeHtml(run.caseset)}</code>：`
    + `${run.cases.length} 个 Case，${successful} 个协议成功，${correlated} 个取得关联 ID。</p>`
    + "<p>本命令只触发 Case 并采集证据，不评价回答质量，也不解释 <code>judge.eval</code>。</p>";
  const caseRows = run.cases.map((item) => [
    item.caseId,
    Object.entries(item.facets ?? {}).map(([name, value]) => `${name}=${value}`).join(", ") || "—",
    item.protocol?.ok ? "ok" : item.error ? "error" : "failed",
    item.observation?.status ?? "—",
    item.observation ? item.observation.durationMs.toFixed(0) : "—",
    item.correlation ? `${item.correlation.key}=${item.correlation.id}` : "—",
    item.error ?? item.protocol?.errorKind ?? "—",
  ]);
  const evidenceRows = (["trace", "log", "data"] as const).map((kind) => [
    kind,
    evidenceLabel(run.evidence[kind]),
    run.evidence[kind].exitCode ?? "—",
  ]);
  const manifest = {
    doctor_version: DOCTOR_CLI_VERSION,
    target: {
      plugin: run.plugin,
      service: run.service,
      caseset: run.caseset,
    },
    params: {
      cases: run.cases.map((item) => item.caseId),
    },
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    steps: run.cases.map((item) => ({
      id: `case-${item.caseId}`,
      title: `触发 Case ${item.caseId}`,
      status: item.protocol?.ok ? "ok" : "failed",
      reason: item.error ?? item.protocol?.errorKind,
      duration_ms: item.observation?.durationMs,
    })),
  };
  writeFileSync(join(path, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(path, "report.html"), buildHtmlReport(manifest, {
    title: "doctor eval 数据采集报告",
    profileName,
    summaryHtml,
    sections: [{
      id: "case-results",
      title: "Case 执行结果",
      html: htmlTable(
        ["Case", "Facets", "协议结果", "HTTP 状态", "耗时 ms", "关联 ID", "错误"],
        caseRows,
        { search: { column: 0, placeholder: "检索 Case" } },
      ),
    }, {
      id: "evidence-results",
      title: "关联证据采集",
      html: htmlTable(["数据面", "状态", "退出码"], evidenceRows),
    }, {
      id: "raw-results",
      title: "结构化产物",
      html: '<p><a href="run.json">run.json</a> · <a href="observations.jsonl">observations.jsonl</a> · <a href="caseset.json">caseset.json</a></p>',
    }],
  }), "utf8");
}

export function writeEvalArtifact(
  artifact: EvalArtifact,
  run: EvalRun,
  caseSet: CaseSet,
  profileName: string,
): void {
  writeFileSync(join(artifact.path, "caseset.json"), `${JSON.stringify(caseSetToRaw(caseSet), null, 2)}\n`, "utf8");
  writeFileSync(join(artifact.path, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(
    join(artifact.path, "observations.jsonl"),
    run.cases.map((item) => JSON.stringify(item)).join("\n") + (run.cases.length ? "\n" : ""),
    "utf8",
  );
  writeEvalReport(artifact.path, run, profileName);
}
