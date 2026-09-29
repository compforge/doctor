import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMemoryAnalysisInputs, runMemoryAnalysis } from "../src/collect/memory/analysis";
import {
  MEMORY_CAPTURE_SCHEMA,
  readMemoryCaptureArtifact,
  resolveCaptureHeapPath,
} from "../src/collect/memory/capture-artifact";
import { resolveHostPydumpAnalyzer } from "../src/infra/dump";
import { CommandContext } from "../src/command";

const createCommandContext = () => new CommandContext({});

function analysis(source: {
  sha256: string;
  size: number;
  createdAt: string;
  dictCount?: number;
  dictBytes?: number;
}) {
  return {
    schema: "pydump.analysis/v1",
    source: {
      sha256: source.sha256,
      size_bytes: source.size,
      heap_format_version: 1,
      created_at: source.createdAt,
      with_string_representations: false,
    },
    heap: {
      object_count: source.dictCount ?? 10,
      type_count: 1,
      thread_count: 0,
      referent_count: 20,
      shallow_size_bytes: source.dictBytes ?? 1024,
    },
    types: [{
      type_address: "0x1",
      type_name: "dict",
      object_count: source.dictCount ?? 10,
      shallow_size_bytes: source.dictBytes ?? 1024,
    }],
    threads: [],
    retained_heap: { status: "complete", top_n: 0, top_objects: [] },
  };
}

describe("doctor mema local analysis", () => {
  test("materializes the standalone Toolkit analyzer", () => {
    expect(existsSync(resolveHostPydumpAnalyzer())).toBe(true);
  });

  test("reuses matching analysis JSON next to an existing heap", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-cache-"));
    const heapPath = join(directory, "capture.pyheap");
    const body = "heap";
    const sha256 = createHash("sha256").update(body).digest("hex");
    writeFileSync(heapPath, body);
    writeFileSync(join(directory, "capture.pydump-analysis.json"), JSON.stringify(analysis({
      sha256,
      size: Buffer.byteLength(body),
      createdAt: "2026-07-27T08:00:00Z",
    })));
    const output = join(directory, "report.html");

    expect(await runMemoryAnalysis({ inputs: [heapPath], output }, createCommandContext())).toBe(0);
    expect(existsSync(output)).toBe(true);
  });

  test("compares multiple analysis JSON files by type deltas", async () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-compare-"));
    const first = join(directory, "first.pydump-analysis.json");
    const second = join(directory, "second.pydump-analysis.json");
    writeFileSync(first, JSON.stringify(analysis({
      sha256: "a".repeat(64), size: 100, createdAt: "2026-07-27T08:00:00Z",
      dictCount: 10, dictBytes: 1024,
    })));
    writeFileSync(second, JSON.stringify(analysis({
      sha256: "b".repeat(64), size: 200, createdAt: "2026-07-27T09:00:00Z",
      dictCount: 25, dictBytes: 4096,
    })));
    const output = join(directory, "comparison.html");

    expect(await runMemoryAnalysis({ inputs: [second, first], output }, createCommandContext())).toBe(0);
    expect(readFileSync(output, "utf-8")).toContain("+15");
  });

  test("reads a capture sidecar and discovers it before derived files", () => {
    const directory = mkdtempSync(join(tmpdir(), "doctor-mema-discovery-"));
    writeFileSync(join(directory, "capture.pyheap"), "heap");
    writeFileSync(join(directory, "capture.pydump-analysis.json"), "{}");
    const capturePath = join(directory, "doctor-mem-app-0-pid12-20260727-080000.json");
    writeFileSync(capturePath, JSON.stringify({
      schema: MEMORY_CAPTURE_SCHEMA,
      captured_at: "2026-07-27T08:00:00Z",
      pyheap_version: "0.7.0+doctor.2",
      target: {
        namespace: "ns", pod: "app-0", container: "app", image: "example/app:1",
        restart_count: 0, pid: 12,
      },
      capture: {
        backend: "pyheap", strategy: "target-container", execution_container: "app",
        detail: "lite", str_repr_len: -1,
      },
      heap: { file: "capture.pyheap", size_bytes: 4, sha256: "a".repeat(64) },
      facts: {},
    }));

    const artifact = readMemoryCaptureArtifact(capturePath);
    expect(resolveCaptureHeapPath(capturePath, artifact)).toBe(join(directory, "capture.pyheap"));
    expect(findMemoryAnalysisInputs(directory)).toEqual([capturePath]);
  });
});
