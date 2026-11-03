import { expect, test } from "bun:test";
import { evaluateCollectOutcome } from "../src/collect/outcome";

test("collect outcome 在完整或部分证据成功交付时返回 0", () => {
  expect(evaluateCollectOutcome(["ok", "ok"])).toEqual({
    delivery: "complete",
    evidence: "complete",
    exitCode: 0,
  });
  expect(evaluateCollectOutcome(["ok", "unavailable"])).toMatchObject({ evidence: "partial", exitCode: 0 });
  expect(evaluateCollectOutcome(["partial", "partial"])).toMatchObject({ evidence: "partial", exitCode: 0 });
  expect(evaluateCollectOutcome(["unavailable", "unavailable"])).toMatchObject({ evidence: "missing", exitCode: 1 });
  expect(evaluateCollectOutcome(["ok", "skipped", "unnecessary"])).toMatchObject({ evidence: "complete", exitCode: 0 });
  expect(evaluateCollectOutcome([])).toMatchObject({ evidence: "complete", exitCode: 0 });
  expect(evaluateCollectOutcome(["ok"], "failed")).toMatchObject({ delivery: "failed", exitCode: 1 });
});
