import { expect, test } from "bun:test";
import { evaluateCollectOutcome } from "../src/collect/outcome";

test("collect outcome 在完整或部分证据成功交付时返回 0", () => {
  expect(evaluateCollectOutcome(["sufficient", "sufficient"])).toEqual({
    delivery: "complete",
    evidence: "complete",
    exitCode: 0,
  });
  expect(evaluateCollectOutcome(["sufficient", "insufficient"])).toMatchObject({ evidence: "partial", exitCode: 0 });
  expect(evaluateCollectOutcome(["partial", "partial"])).toMatchObject({ evidence: "partial", exitCode: 0 });
  expect(evaluateCollectOutcome(["insufficient", "insufficient"])).toMatchObject({ evidence: "missing", exitCode: 1 });
  expect(evaluateCollectOutcome([])).toMatchObject({ evidence: "missing", exitCode: 1 });
  expect(evaluateCollectOutcome(["sufficient"], "failed")).toMatchObject({ delivery: "failed", exitCode: 1 });
});
