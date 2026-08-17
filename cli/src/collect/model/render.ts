import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
  htmlTableCell,
} from "../output/html";
import type {
  ModelDiagnosis,
  ModelResponseObservation,
} from "./model";
import type {
  ModelPerformanceAttempt,
  ModelPerformanceSummary,
} from "./performance";

function milliseconds(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`;
}

function rate(value: number | undefined, unit: string): string {
  return value === undefined ? "—" : `${value.toFixed(2)} ${unit}`;
}

function numberCell(value: number | undefined, render: (value: number) => string) {
  return value === undefined ? "—" : htmlTableCell(render(value), value);
}

function rangeCell(
  minimum: number | undefined,
  median: number | undefined,
  maximum: number | undefined,
  render: (value: number) => string,
) {
  return minimum === undefined || median === undefined || maximum === undefined
    ? "—"
    : htmlTableCell(
        `${render(median)}（${render(minimum)}–${render(maximum)}）`,
        median,
      );
}

export function buildModelPerformanceTerminalSummary(
  summaries: readonly ModelPerformanceSummary[],
): string[] {
  const decode = summaries.find((summary) => summary.kind === "decode");
  if (!decode) return [];
  const samples = `${decode.successful}/${decode.total} 次成功`;
  const tokensPerSecond = decode.outputTokensPerSecondP50;
  if (tokensPerSecond === undefined) {
    return [`[model] 当前单请求持续生成：output TPS 不可用（${samples}）\n`];
  }

  const charactersPerSecond = decode.outputCharactersPerSecondP50;
  const throughput = `[model] 当前单请求持续生成：${tokensPerSecond.toFixed(2)} tokens/s`
    + (charactersPerSecond === undefined
      ? ""
      : `；本次样本文本约 ${charactersPerSecond.toFixed(2)} chars/s`)
    + `（P50，${samples}）\n`;
  const firstOutput = decode.ttfoP50Ms === undefined
    ? ""
    : `首个可见输出约 ${(decode.ttfoP50Ms / 1_000).toFixed(2)}s + `;
  const estimate = `[model] 业务输出耗时粗估：${firstOutput}输出 token 数 / ${tokensPerSecond.toFixed(2)} tokens/s`
    + (charactersPerSecond === undefined
      ? "；字符数需先按业务文本 tokenizer 换算"
      : `；与本次样本相近的文本也可按 ${firstOutput}字符数 / ${charactersPerSecond.toFixed(2)} chars/s 估算`)
    + "（仅代表当前单请求）\n";
  return [throughput, estimate];
}

export function buildModelMarkdown(
  diagnosis: ModelDiagnosis,
  summaries: readonly ModelPerformanceSummary[],
  attempts: readonly ModelPerformanceAttempt[],
): string {
  const lines = [
    "# doctor model diagnosis",
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.map(
      (item) => `- ${item.goal}: ${item.status}${
        item.missingEvidence.length ? `（${item.missingEvidence.join("；")}）` : ""
      }`,
    ),
    "",
    "## Findings",
    "",
    ...(diagnosis.findings.length
      ? diagnosis.findings.map(
          (finding) => `- [${finding.severity}] ${finding.kind}: ${finding.summary}`,
        )
      : ["- 未发现异常"]),
  ];
  if (attempts.length) {
    lines.push(
      "",
      "## Performance",
      "",
      `- samples: ${attempts.length}`,
      `- successful: ${attempts.filter((attempt) => attempt.success).length}`,
      ...summaries.map(
        (summary) => `- ${summary.caseLabel}: success=${
          summary.successful
        }/${summary.total}, ttft_p50_ms=${summary.ttftP50Ms ?? "n/a"}, tpot_p50_ms=${
          summary.tpotP50Ms ?? "n/a"
        }, output_tokens_per_second_p50=${
          summary.outputTokensPerSecondP50 ?? "n/a"
        }, output_characters_per_second_p50=${
          summary.outputCharactersPerSecondP50 ?? "n/a"
        }`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildModelDiagnosisHtml(
  diagnosis: ModelDiagnosis,
  summaries: readonly ModelPerformanceSummary[],
  attempts: readonly ModelPerformanceAttempt[],
): string {
  const successful = attempts.filter((attempt) => attempt.success).length;
  const responses = diagnosis.evidence.observations.filter(
    (item): item is ModelResponseObservation =>
      item.kind === "model-validation" || item.kind === "model-inference",
  );
  const unavailableDecodeMetrics = attempts.filter(
    (attempt) =>
      attempt.kind === "decode"
      && attempt.success
      && attempt.tokenMetricsUnavailableReason !== undefined,
  ).length;
  return [
    htmlHeading(1, attempts.length ? "模型推理性能采样" : "模型推理诊断"),
    htmlHeading(2, "诊断覆盖"),
    htmlTable(
      ["目标", "覆盖状态", "缺失证据"],
      diagnosis.coverage.map((item) => [
        item.goal,
        item.status,
        item.missingEvidence.join("；") || "—",
      ]),
    ),
    htmlHeading(2, "Probe 响应"),
    htmlTable(
      ["Probe", "HTTP", "耗时", "错误"],
      responses.map((observation) => [
        observation.kind,
        observation.response?.statusCode ?? "—",
        observation.response
          ? htmlTableCell(
              milliseconds(observation.response.durationMs),
              observation.response.durationMs,
            )
          : "—",
        observation.error
          ?? (observation.response?.ok === false ? observation.response.text : "—"),
      ]),
    ),
    htmlHeading(2, "Detector Findings"),
    diagnosis.findings.length
      ? htmlTable(
          ["严重度", "类型", "结论"],
          diagnosis.findings.map((finding) => [
            finding.severity,
            finding.kind,
            finding.summary,
          ]),
        )
      : htmlParagraph("未发现异常。"),
    ...(attempts.length ? [
      htmlHeading(2, "性能采样概览"),
    htmlList([
      `采样请求：${attempts.length}`,
      `成功：${successful}`,
      `失败：${attempts.length - successful}`,
      `成功率：${attempts.length ? (successful * 100 / attempts.length).toFixed(1) : "0.0"}%`,
      unavailableDecodeMetrics
        ? `${unavailableDecodeMetrics} 个持续生成样本无法计算 TPOT/output TPS；逐次结果中保留原因`
        : "持续生成样本均可计算 TPOT/output TPS",
      "当前为串行轻量采样，不表示并发负载、容量或负载下尾延迟。",
    ]),
    htmlHeading(2, "按测试场景聚合"),
    htmlTable(
      [
        "场景",
        "类型",
        "prompt chars",
        "prompt tokens P50",
        "completion tokens P50",
        "最大输出 tokens",
        "成功率",
        "TTFT P50（min–max）",
        "TTFO P50（min–max）",
        "总耗时 P50（min–max）",
        "TPOT P50（min–max）",
        "output TPS P50",
        "chars/s P50",
        "ICL max",
      ],
      summaries.map((summary) => [
        summary.caseLabel,
        summary.kind,
        summary.promptCharacters,
        summary.promptTokensP50 ?? "—",
        summary.completionTokensP50 ?? "—",
        summary.maxOutputTokens,
        htmlTableCell(
          `${(summary.successRate * 100).toFixed(1)}%`,
          summary.successRate,
        ),
        rangeCell(summary.ttftMinMs, summary.ttftP50Ms, summary.ttftMaxMs, milliseconds),
        rangeCell(summary.ttfoMinMs, summary.ttfoP50Ms, summary.ttfoMaxMs, milliseconds),
        rangeCell(
          summary.durationMinMs,
          summary.durationP50Ms,
          summary.durationMaxMs,
          milliseconds,
        ),
        rangeCell(summary.tpotMinMs, summary.tpotP50Ms, summary.tpotMaxMs, milliseconds),
        numberCell(summary.outputTokensPerSecondP50, (value) => rate(value, "tokens/s")),
        numberCell(summary.outputCharactersPerSecondP50, (value) => rate(value, "chars/s")),
        numberCell(summary.maxInterChunkLatencyMs, milliseconds),
      ]),
    ),
    htmlHeading(2, "逐次采样"),
    htmlTable(
      [
        "场景",
        "轮次",
        "成功",
        "HTTP",
        "prompt tokens",
        "completion tokens",
        "TTFT",
        "TTFO",
        "生成耗时",
        "总耗时",
        "TPOT",
        "output TPS",
        "chars/s",
        "语义 SSE events",
        "ICL P95",
        "ICL max",
        "token 指标不可用原因",
        "SSE DONE",
        "finish reason",
        "错误",
      ],
      attempts.map((attempt) => [
        attempt.caseLabel,
        attempt.round,
        attempt.success,
        attempt.statusCode ?? "—",
        attempt.promptTokens ?? "—",
        attempt.completionTokens ?? "—",
        numberCell(attempt.ttftMs, milliseconds),
        numberCell(attempt.ttfoMs, milliseconds),
        numberCell(attempt.generationDurationMs, milliseconds),
        htmlTableCell(milliseconds(attempt.durationMs), attempt.durationMs),
        numberCell(attempt.tpotMs, milliseconds),
        numberCell(attempt.outputTokensPerSecond, (value) => rate(value, "tokens/s")),
        numberCell(attempt.outputCharactersPerSecond, (value) => rate(value, "chars/s")),
        attempt.semanticEventCount,
        numberCell(attempt.p95InterChunkLatencyMs, milliseconds),
        numberCell(attempt.maxInterChunkLatencyMs, milliseconds),
        attempt.tokenMetricsUnavailableReason ?? "—",
        attempt.terminalReceived,
        attempt.finishReason ?? "—",
        attempt.error ?? "—",
      ]),
    ),
    htmlHeading(2, "指标口径"),
    htmlParagraph(
      "TTFT 从请求开始计算到首个非空 content、reasoning 或 tool-call SSE event；"
      + "TTFO 是首个非 reasoning 可见输出。TPOT = 首尾语义输出到达间隔 / "
      + "(completion_tokens - 1)，output TPS 是其倒数；ICL 只表示相邻语义 SSE event "
      + "的客户端到达间隔，不等同于逐 token 延迟。",
    ),
    ] : []),
  ].join("");
}
