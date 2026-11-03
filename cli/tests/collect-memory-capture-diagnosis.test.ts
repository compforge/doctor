import { describe, expect, test } from "bun:test";
import {
  detectMemoryCaptureEvidenceGaps,
  buildMemoryCaptureEvidence,
  memoryCaptureDetectors,
} from "../src/collect/memory/capture-diagnosis";
import { collectedFact } from "../src/collect/protocol";

describe("Memory Capture diagnosis", () => {
  test("成功形成 heap 与 capture index 时 Coverage sufficient", () => {
    const evidence = buildMemoryCaptureEvidence([{
      id: "memory-heap-capture",
      kind: "memory.heap-capture",
      schemaVersion: 1,
      producer: { origin: "core", id: "memory-heap-capture" },
      result: { code: 0, heapPath: "heap.pyheap", capturePath: "capture.json" },
    }], { cgroupMemory: collectedFact("target.cgroup-memory", "cgroup-memory", { version: 2 as const, events: {} }) });

    expect(memoryCaptureDetectors).toEqual([]);
    expect(detectMemoryCaptureEvidenceGaps(evidence)).toEqual([]);
  });

  test("采集失败原因进入 insufficient Coverage", () => {
    const evidence = buildMemoryCaptureEvidence([{
      id: "memory-heap-capture",
      kind: "memory.heap-capture",
      schemaVersion: 1,
      producer: { origin: "core", id: "memory-heap-capture" },
      result: { code: 1, reasons: ["attach 失败", "heap 未生成"] },
    }], {});

    expect(detectMemoryCaptureEvidenceGaps(evidence)).toEqual([expect.objectContaining({ kind: "evidence.insufficient", subject: "memory-heap-artifact", message: ["attach 失败", "heap 未生成"].join("；") })]);
  });
});
