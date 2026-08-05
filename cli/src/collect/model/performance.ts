import type { ObservedSseFrame } from "../shared/http/sse-observation";
import type {
  ModelPerformanceObservation,
  ModelPerformanceWorkload,
  ModelStreamSnapshot,
  SelectedInferenceModel,
} from "./model";

export type ModelPerformanceWorkloadKind = ModelPerformanceWorkload["kind"];

export interface ModelPerformanceCase extends ModelPerformanceWorkload {
  prompt: string;
}

export interface ModelPerformanceAttempt {
  caseId: string;
  caseLabel: string;
  kind: ModelPerformanceWorkloadKind;
  round: number;
  promptCharacters: number;
  maxOutputTokens: number;
  success: boolean;
  statusCode?: number;
  durationMs: number;
  ttftMs?: number;
  ttfoMs?: number;
  generationDurationMs?: number;
  tpotMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  outputCharacters: number;
  outputTokensPerSecond?: number;
  outputCharactersPerSecond?: number;
  tokenMetricsUnavailableReason?: string;
  semanticEventCount: number;
  p95InterChunkLatencyMs?: number;
  maxInterChunkLatencyMs?: number;
  terminalReceived: boolean;
  finishReason?: string;
  error?: string;
}

export interface ModelPerformanceSummary {
  caseId: string;
  caseLabel: string;
  kind: ModelPerformanceWorkloadKind;
  promptCharacters: number;
  maxOutputTokens: number;
  total: number;
  successful: number;
  successRate: number;
  promptTokensP50?: number;
  completionTokensP50?: number;
  ttftMinMs?: number;
  ttftP50Ms?: number;
  ttftMaxMs?: number;
  ttfoMinMs?: number;
  ttfoP50Ms?: number;
  ttfoMaxMs?: number;
  durationMinMs?: number;
  durationP50Ms?: number;
  durationMaxMs?: number;
  tpotMinMs?: number;
  tpotP50Ms?: number;
  tpotMaxMs?: number;
  outputTokensPerSecondP50?: number;
  maxInterChunkLatencyMs?: number;
}

const SAMPLE_PREFIX_CHARACTERS = 80;
const PREFILL_CASES = [
  { id: "prefill-short", label: "短输入", characters: 1_024 },
  { id: "prefill-medium", label: "中输入", characters: 8_192 },
  { id: "prefill-long", label: "长输入", characters: 32_768 },
] as const;

function contextPrompt(characters: number): string {
  const unit = "Doctor model performance context. Keep reading until the final instruction. ";
  const context = unit.repeat(Math.ceil(characters / unit.length)).slice(0, characters);
  return `${context}\n\nReply with OK only.`;
}

function decodingPrompt(): string {
  return [
    "Generate a long sequence of numbered lines.",
    "Each line must contain the words: doctor model performance sample.",
    "Continue until the output token limit stops you.",
  ].join(" ");
}

function samplePrefix(sampleKey: string): string {
  const value = `Doctor model performance sample ${sampleKey}. `;
  return value.padEnd(SAMPLE_PREFIX_CHARACTERS, "#").slice(0, SAMPLE_PREFIX_CHARACTERS);
}

function chatRequest(
  model: SelectedInferenceModel,
  prompt: string,
  maxOutputTokens: number,
): Record<string, unknown> {
  return {
    model: model.inference.model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
    max_completion_tokens: maxOutputTokens,
  };
}

export function buildModelPerformanceSuite(
  decodeOutputTokens: number,
): ModelPerformanceCase[] {
  const prefill = PREFILL_CASES.map((item): ModelPerformanceCase => {
    const prompt = contextPrompt(item.characters);
    return {
      id: item.id,
      label: item.label,
      kind: "prefill",
      promptCharacters: SAMPLE_PREFIX_CHARACTERS + prompt.length,
      maxOutputTokens: 16,
      prompt,
    };
  });
  const prompt = decodingPrompt();
  return [
    ...prefill,
    {
      id: "decode",
      label: "持续生成",
      kind: "decode",
      promptCharacters: SAMPLE_PREFIX_CHARACTERS + prompt.length,
      maxOutputTokens: decodeOutputTokens,
      prompt,
    },
  ];
}

export function buildModelPerformanceRequest(
  model: SelectedInferenceModel,
  testCase: ModelPerformanceCase,
  sampleKey: string,
): Record<string, unknown> {
  return chatRequest(
    model,
    `${samplePrefix(sampleKey)}${testCase.prompt}`,
    testCase.maxOutputTokens,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** 只消费 OpenAI chat completion 语义；SSE framing 和时间线留在 shared/http。 */
export class OpenAiChatStreamObserver {
  private readonly semanticEventTimesMs: number[] = [];
  private readonly visibleOutputEventTimesMs: number[] = [];
  private outputCharacters = 0;
  private promptTokens?: number;
  private completionTokens?: number;
  private totalTokens?: number;
  private finishReason?: string;
  private streamError?: string;

  observe(frame: ObservedSseFrame): void {
    const payload = record(frame.parsedData);
    if (!payload) return;
    let semantic = false;
    let visibleOutput = false;
    const error = record(payload.error);
    if (error) {
      this.streamError = stringField(error.message) ?? JSON.stringify(error);
    }
    const usage = record(payload.usage);
    if (usage) {
      this.promptTokens = numberField(usage.prompt_tokens) ?? this.promptTokens;
      this.completionTokens = numberField(usage.completion_tokens) ?? this.completionTokens;
      this.totalTokens = numberField(usage.total_tokens) ?? this.totalTokens;
    }

    const topLevelResult = stringField(payload.result);
    if (topLevelResult) {
      semantic = true;
      visibleOutput = true;
      this.outputCharacters += topLevelResult.length;
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const rawChoice of choices) {
      const choice = record(rawChoice);
      if (!choice) continue;
      this.finishReason = stringField(choice.finish_reason) ?? this.finishReason;
      const delta = record(choice.delta);
      const content = stringField(delta?.content);
      const reasoning = ["reasoning_content", "reasoning"]
        .map((field) => stringField(delta?.[field]))
        .filter((value): value is string => value !== undefined);
      const toolCalls = delta?.tool_calls;
      if (content) {
        semantic = true;
        visibleOutput = true;
        this.outputCharacters += content.length;
      }
      if (reasoning.length) {
        semantic = true;
        this.outputCharacters += reasoning.reduce((total, part) => total + part.length, 0);
      }
      if (Array.isArray(toolCalls) && toolCalls.length > 0) semantic = true;
    }
    if (semantic) this.semanticEventTimesMs.push(frame.receivedAtMs);
    if (visibleOutput) this.visibleOutputEventTimesMs.push(frame.receivedAtMs);
  }

  result(): ModelStreamSnapshot {
    return {
      semanticEventTimesMs: this.semanticEventTimesMs,
      visibleOutputEventTimesMs: this.visibleOutputEventTimesMs,
      outputCharacters: this.outputCharacters,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      finishReason: this.finishReason,
      streamError: this.streamError,
    };
  }
}

function percentile(values: readonly number[], ratio: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function rate(count: number | undefined, durationMs: number | undefined): number | undefined {
  return count !== undefined && count > 0 && durationMs !== undefined && durationMs > 0
    ? count / (durationMs / 1000)
    : undefined;
}

function minimum(values: readonly number[]): number | undefined {
  return values.length ? Math.min(...values) : undefined;
}

function maximum(values: readonly number[]): number | undefined {
  return values.length ? Math.max(...values) : undefined;
}

export function analyzeModelPerformanceObservation(
  observation: ModelPerformanceObservation,
): ModelPerformanceAttempt {
  const { capture, stream, workload, round } = observation;
  const startedAtMs = Date.parse(capture.response.startedAt);
  const firstSemanticAt = stream.semanticEventTimesMs[0];
  const lastSemanticAt = stream.semanticEventTimesMs.at(-1);
  const firstVisibleOutputAt = stream.visibleOutputEventTimesMs[0];
  const generationDurationMs = firstSemanticAt === undefined || lastSemanticAt === undefined
    ? undefined
    : Math.max(0, lastSemanticAt - firstSemanticAt);
  const interChunkLatencies = stream.semanticEventTimesMs.slice(1).map(
    (value, index) => Math.max(0, value - stream.semanticEventTimesMs[index]!),
  );
  const generatedTokenIntervals = stream.completionTokens === undefined
    ? undefined
    : stream.completionTokens - 1;
  const tokenMetricsUnavailableReason = stream.completionTokens === undefined
    ? "响应未返回 completion_tokens"
    : stream.completionTokens < 2
      ? `实际输出仅 ${stream.completionTokens} token`
      : generationDurationMs === undefined || generationDurationMs <= 0
        ? "有效语义 SSE event 不足，无法得到生成区间"
        : undefined;
  const terminalReceived = capture.sse?.timeline.terminalReceived ?? false;
  const success = capture.response.captureComplete
    && capture.response.statusCode === 200
    && firstSemanticAt !== undefined
    && terminalReceived
    && !stream.streamError;
  const error = capture.response.error
    ?? stream.streamError
    ?? (capture.response.statusCode !== 200 ? `HTTP ${capture.response.statusCode ?? "unknown"}` : undefined)
    ?? (firstSemanticAt === undefined ? "SSE 未返回有效模型内容" : undefined)
    ?? (!terminalReceived ? "SSE 未收到 [DONE]" : undefined);
  const tpotMs = generatedTokenIntervals !== undefined
    && generatedTokenIntervals > 0
    && generationDurationMs !== undefined
    && generationDurationMs > 0
    ? generationDurationMs / generatedTokenIntervals
    : undefined;
  return {
    caseId: workload.id,
    caseLabel: workload.label,
    kind: workload.kind,
    round,
    promptCharacters: workload.promptCharacters,
    maxOutputTokens: workload.maxOutputTokens,
    success,
    statusCode: capture.response.statusCode,
    durationMs: capture.response.durationMs,
    ttftMs: firstSemanticAt === undefined ? undefined : Math.max(0, firstSemanticAt - startedAtMs),
    ttfoMs: firstVisibleOutputAt === undefined
      ? undefined
      : Math.max(0, firstVisibleOutputAt - startedAtMs),
    generationDurationMs,
    tpotMs,
    promptTokens: stream.promptTokens,
    completionTokens: stream.completionTokens,
    totalTokens: stream.totalTokens,
    outputCharacters: stream.outputCharacters,
    outputTokensPerSecond: tpotMs === undefined ? undefined : 1_000 / tpotMs,
    outputCharactersPerSecond: rate(stream.outputCharacters, generationDurationMs),
    tokenMetricsUnavailableReason,
    semanticEventCount: stream.semanticEventTimesMs.length,
    p95InterChunkLatencyMs: percentile(interChunkLatencies, 0.95),
    maxInterChunkLatencyMs: maximum(interChunkLatencies),
    terminalReceived,
    finishReason: stream.finishReason,
    error,
  };
}

export function summarizeModelPerformance(
  attempts: readonly ModelPerformanceAttempt[],
): ModelPerformanceSummary[] {
  const grouped = new Map<string, ModelPerformanceAttempt[]>();
  for (const attempt of attempts) {
    const values = grouped.get(attempt.caseId) ?? [];
    values.push(attempt);
    grouped.set(attempt.caseId, values);
  }
  return [...grouped.values()].map((values) => {
    const first = values[0]!;
    const successful = values.filter((value) => value.success);
    const metric = (pick: (value: ModelPerformanceAttempt) => number | undefined) =>
      successful.map(pick).filter((value): value is number => value !== undefined);
    const ttft = metric((value) => value.ttftMs);
    const ttfo = metric((value) => value.ttfoMs);
    const duration = metric((value) => value.durationMs);
    const tpot = metric((value) => value.tpotMs);
    const throughput = metric((value) => value.outputTokensPerSecond);
    const maxIcl = metric((value) => value.maxInterChunkLatencyMs);
    return {
      caseId: first.caseId,
      caseLabel: first.caseLabel,
      kind: first.kind,
      promptCharacters: first.promptCharacters,
      maxOutputTokens: first.maxOutputTokens,
      total: values.length,
      successful: successful.length,
      successRate: successful.length / values.length,
      promptTokensP50: percentile(metric((value) => value.promptTokens), 0.5),
      completionTokensP50: percentile(metric((value) => value.completionTokens), 0.5),
      ttftMinMs: minimum(ttft),
      ttftP50Ms: percentile(ttft, 0.5),
      ttftMaxMs: maximum(ttft),
      ttfoMinMs: minimum(ttfo),
      ttfoP50Ms: percentile(ttfo, 0.5),
      ttfoMaxMs: maximum(ttfo),
      durationMinMs: minimum(duration),
      durationP50Ms: percentile(duration, 0.5),
      durationMaxMs: maximum(duration),
      tpotMinMs: minimum(tpot),
      tpotP50Ms: percentile(tpot, 0.5),
      tpotMaxMs: maximum(tpot),
      outputTokensPerSecondP50: percentile(throughput, 0.5),
      maxInterChunkLatencyMs: maximum(maxIcl),
    };
  });
}
