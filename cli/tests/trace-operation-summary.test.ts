import { expect, test } from "bun:test";
import { accumulateStats, newTraceStats, type TraceStats } from "../src/collect/trace/probe";
import { buildTraceSummary } from "../src/collect/trace/render";

function summary(stats: TraceStats): string {
  return buildTraceSummary({ traceId: "t1", index: "local_file", channel: "file", count: stats.total,
    downloaded: stats.total, stats, steps: [] });
}

function span(service: string, operationName: string, startTimeMillis?: number, duration = 1000) {
  return { process: { serviceName: service }, operationName, startTimeMillis, duration };
}

test("groups across unordered pages and separates repeated operations by service", () => {
  const stats = newTraceStats();
  accumulateStats(stats, [span("control", "GetModel", 5000), span("agent", "GetModel", 2000)]);
  accumulateStats(stats, [span("control", "GetModel", 1000, 10_000_000), span("control", "GetModel", 3000),
    span("control", "ListModels", 7000)]);
  expect([...stats.operations.values()]).toEqual([
    { service: "control", operation: "GetModel", count: 3, firstStartMs: 1000, lastStartMs: 5000, lastEndMs: 11000 },
    { service: "agent", operation: "GetModel", count: 1, firstStartMs: 2000, lastStartMs: 2000, lastEndMs: 2001 },
    { service: "control", operation: "ListModels", count: 1, firstStartMs: 7000, lastStartMs: 7000, lastEndMs: 7001 },
  ]);
  expect(summary(stats)).toContain("| control | GetModel | 3 | 1970-01-01T00:00:01.000Z | 1970-01-01T00:00:05.000Z | 1970-01-01T00:00:11.000Z |");
});

test("a 64 minute repeated-operation tail is coverage, not question-answer latency", () => {
  const stats = newTraceStats();
  accumulateStats(stats, [span("chat", "answer", 0, 5_000_000)]);
  for (let minute = 64; minute >= 0; minute--) {
    accumulateStats(stats, [span("control", "GetModel", minute * 60_000)]);
  }
  const md = summary(stats);
  expect(md).toContain("跨度 3840001ms；不代表问答耗时");
  expect(md).toContain("| control | GetModel | 65 | 1970-01-01T00:00:00.000Z | 1970-01-01T01:04:00.000Z | 1970-01-01T01:04:00.001Z |");
  expect(md).toContain("| chat | answer | 1 | 1970-01-01T00:00:00.000Z | 1970-01-01T00:00:00.000Z | 1970-01-01T00:00:05.000Z |");
  expect(md).toContain("需结合原始证据确认");
});

test("missing times stay unknown and Jaeger microsecond start times are supported", () => {
  const stats = newTraceStats();
  accumulateStats(stats, [{}, { operationName: "known", startTime: 2_000_000, duration: 500_000 },
    span("partial", "mixed"), span("partial", "mixed", 1000)]);
  const md = summary(stats);
  expect(md).toContain("| (unknown) | (unknown) | 1 | 未知 | 未知 | 未知 |");
  expect(md).toContain("| (unknown) | known | 1 | 1970-01-01T00:00:02.000Z | 1970-01-01T00:00:02.000Z | 1970-01-01T00:00:02.500Z |");
  expect(md).toContain("| partial | mixed | 2 | 1970-01-01T00:00:01.000Z |");
});

test("group identity is exact and rendering escapes untrusted service and operation names", () => {
  const stats = newTraceStats();
  accumulateStats(stats, [span("a/b", "c", 0), span("a", "b/c", 0),
    span("<script>|service", "<img>\noperation", 0)]);
  expect(stats.operations.size).toBe(3);
  const md = summary(stats);
  expect(md).toContain("&lt;script&gt;\\|service");
  expect(md).toContain("&lt;img&gt; operation");
  expect(md).not.toContain("<script>");
  expect(md).not.toContain("<img>");
});

test("bounded groups prioritize repetition and link omitted rows to raw evidence", () => {
  const stats = newTraceStats();
  accumulateStats(stats, Array.from({ length: 25 }, (_, i) => span("svc", `operation-${i}`, i)));
  accumulateStats(stats, [span("svc", "GetModel", 100), span("svc", "GetModel", 200)]);
  const table = summary(stats).split("## 按 Service / Operation 分组")[1]!.split("## 步骤状态")[0]!;
  expect(table.match(/^\| svc \|/gm)).toHaveLength(20);
  expect(table.indexOf("| svc | GetModel | 2 |")).toBeLessThan(table.indexOf("| svc | operation-0 |"));
  expect(table).toContain("另有 6 组未展示，见 [原始 spans](spans.jsonl)");
  expect(summary(newTraceStats())).not.toContain("## 按 Service / Operation 分组");
});
