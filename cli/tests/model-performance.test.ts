import { describe, expect, test } from "bun:test";
import {
  summarizeModelPerformance,
  type ModelPerformanceAttempt,
} from "../src/collect/model";
import { buildModelPerformanceTerminalSummary } from "../src/collect/model/render";

function attempt(overrides: Partial<ModelPerformanceAttempt> = {}): ModelPerformanceAttempt {
  return {
    caseId: "decode",
    caseLabel: "持续生成",
    kind: "decode",
    round: 1,
    promptCharacters: 100,
    maxOutputTokens: 256,
    success: true,
    durationMs: 3_000,
    ttfoMs: 800,
    outputCharacters: 600,
    outputTokensPerSecond: 40,
    outputCharactersPerSecond: 120,
    semanticEventCount: 10,
    terminalReceived: true,
    ...overrides,
  };
}

describe("doctor model performance summary", () => {
  test("reports current output TPS and a business latency estimate", () => {
    const summaries = summarizeModelPerformance([
      attempt(),
      attempt({ round: 2, outputTokensPerSecond: 50, outputCharactersPerSecond: 150 }),
      attempt({ round: 3, outputTokensPerSecond: 45, outputCharactersPerSecond: 135 }),
    ]);

    expect(summaries[0]?.outputCharactersPerSecondP50).toBe(135);
    expect(buildModelPerformanceTerminalSummary(summaries)).toEqual([
      "[model] 当前单请求持续生成：45.00 tokens/s；本次样本文本约 135.00 chars/s（P50，3/3 次成功）\n",
      "[model] 业务输出耗时粗估：首个可见输出约 0.80s + 输出 token 数 / 45.00 tokens/s；与本次样本相近的文本也可按 首个可见输出约 0.80s + 字符数 / 135.00 chars/s 估算（仅代表当前单请求）\n",
    ]);
  });

  test("states when token throughput is unavailable", () => {
    const summaries = summarizeModelPerformance([
      attempt({ outputTokensPerSecond: undefined }),
    ]);

    expect(buildModelPerformanceTerminalSummary(summaries)).toEqual([
      "[model] 当前单请求持续生成：output TPS 不可用（1/1 次成功）\n",
    ]);
  });
});
