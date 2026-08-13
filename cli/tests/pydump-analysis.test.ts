import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosePydumpAnalysis } from "../src/collect/memory/detector/pydump";
import {
  PYDUMP_ANALYSIS_SCHEMA,
  readPydumpAnalysis,
  type PydumpAnalysis,
} from "../src/collect/memory/pydump-analysis";
import { buildPydumpAnalysisHtml } from "../src/collect/memory/pydump-render";

function analysis(retainedBytes = 2_000_000): PydumpAnalysis {
  return {
    schema: PYDUMP_ANALYSIS_SCHEMA,
    source: {
      sha256: "a".repeat(64),
      size_bytes: 100_000_000,
      heap_format_version: 1,
      created_at: "2026-07-21T09:00:00+08:00",
      with_string_representations: false,
    },
    heap: {
      object_count: 1_000_000,
      type_count: 2,
      thread_count: 1,
      referent_count: 3_000_000,
      shallow_size_bytes: 100_000_000,
    },
    types: [
      { type_address: "0x1", type_name: "dict", object_count: 500_000, shallow_size_bytes: 40_000_000 },
      { type_address: "0x2", type_name: "str", object_count: 300_000, shallow_size_bytes: 15_000_000 },
    ],
    threads: [{
      name: "MainThread",
      is_alive: true,
      is_daemon: false,
      retained_size_bytes: 0,
      frames: [],
    }],
    retained_heap: {
      status: "complete",
      top_n: 100,
      top_objects: [{
        object_address: "0x3",
        type_name: "dict",
        shallow_size_bytes: 10_000,
        retained_size_bytes: retainedBytes,
        string_representation: null,
        container_profile: null,
        inbound_reference_paths: [],
      }],
    },
  };
}

describe("Pydump analysis detector", () => {
  test("协议 reader 只接受 pydump.analysis/v1", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-pydump-analysis-"));
    const valid = join(dir, "valid.json");
    const invalid = join(dir, "invalid.json");
    writeFileSync(valid, JSON.stringify(analysis()));
    writeFileSync(invalid, JSON.stringify({ schema: "pyheap.analysis/v1" }));
    expect(readPydumpAnalysis(valid).heap.object_count).toBe(1_000_000);
    expect(() => readPydumpAnalysis(invalid)).toThrow(PYDUMP_ANALYSIS_SCHEMA);
  });

  test("区分类型集中与单一 retained owner，不把单快照说成已确认泄漏", () => {
    const diagnosis = diagnosePydumpAnalysis(analysis(60_000_000));
    expect(diagnosis.findings.map((finding) => finding.kind)).toEqual([
      "memory.pydump-type-concentration",
      "memory.pydump-retained-owners",
    ]);
    expect(diagnosis.coverage.find((item) => item.goal === "retained-ownership")?.status)
      .toBe("sufficient");
    expect(diagnosis.coverage.find((item) => item.goal === "leak-confirmation")?.status)
      .toBe("insufficient");
  });

  test("没有大 owner 时明确报告持有分散，并渲染人类可读说明", () => {
    const input = analysis();
    const diagnosis = diagnosePydumpAnalysis(input);
    expect(diagnosis.findings.at(-1)?.kind).toBe("memory.pydump-retained-distributed");
    const html = buildPydumpAnalysisHtml(input, diagnosis);
    expect(html).toContain("没有单个对象保留超过对象堆 5%");
    expect(html).toContain("单次快照不能单独证明内存泄漏");
    expect(html).toContain("Retained owner Top-N");
  });

  test("不采集字符串也能用容器画像识别 sys.path_importer_cache", () => {
    const input = analysis();
    input.retained_heap.top_objects[0]!.container_profile = {
      item_count: 713,
      key_types: [{ type_name: "str", object_count: 713 }],
      value_types: [
        { type_name: "FileFinder", object_count: 711 },
        { type_name: "NoneType", object_count: 2 },
      ],
    };
    input.retained_heap.top_objects[0]!.inbound_reference_paths = [[
      { object_address: "0x4", type_name: "dict" },
      { object_address: "0x5", type_name: "module" },
    ]];

    const diagnosis = diagnosePydumpAnalysis(input);
    expect(diagnosis.findings.some((finding) => (
      finding.kind === "memory.pydump-known-runtime-owner"
      && finding.runtimeOwner === "sys.path_importer_cache"
    ))).toBe(true);
    const html = buildPydumpAnalysisHtml(input, diagnosis);
    expect(html).toContain("sys.path_importer_cache");
    expect(html).toContain("FileFinder × 711");
    expect(html).toContain("dict → module");
  });
});
