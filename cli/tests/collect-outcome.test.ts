import { expect, test } from "bun:test";
import { evaluateCollectOutcome } from "../src/collect/outcome";

test("collect outcome 只在要求证据完整且交付成功时返回 0", () => {
  expect(evaluateCollectOutcome([true, true])).toEqual({
    delivery: "complete",
    evidence: "complete",
    exitCode: 0,
  });
  expect(evaluateCollectOutcome([true, false])).toMatchObject({ evidence: "partial", exitCode: 1 });
  expect(evaluateCollectOutcome([false, false])).toMatchObject({ evidence: "missing", exitCode: 1 });
  expect(evaluateCollectOutcome([])).toMatchObject({ evidence: "missing", exitCode: 1 });
  expect(evaluateCollectOutcome([true], "failed")).toMatchObject({ delivery: "failed", exitCode: 1 });
});
