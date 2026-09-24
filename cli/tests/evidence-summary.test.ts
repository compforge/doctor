import { expect, test } from "bun:test";
import type { DataDiagnosis, DataFacts } from "../src/collect/data/model";
import { buildDataEvidenceSummary, projectDataSummary } from "../src/collect/data/summary";
import { collectedFact } from "../src/collect/protocol";
import { CommandStatus } from "../src/command";
import { accumulateStats, newTraceStats } from "../src/collect/trace/probe";
import { buildTraceSummary } from "../src/collect/trace/render";

function query(id: string, status = "running") {
  return { id, stage: "provide" as const, service: "sample", identity: { kind: "biz_id", value: id },
    ...collectedFact("data.inspect-result", "test", { result: {
      resolution: { inputId: id, resolvedAs: "run_id", identifiers: { run_id: "run-1" } },
      facts: [{ factType: "record" as const, kind: "sample-run", schemaVersion: 1, recordKey: "run-1",
        record: { data: { status, attempt: 0, finished: false, secret: "not-a-display-field" } },
        summary: { title: "Run", fields: [
          { label: "status", path: ["data", "status"] }, { label: "attempt", path: ["data", "attempt"] },
          { label: "finished", path: ["data", "finished"] }, { label: "missing", path: ["data", "absent"] },
        ] } }],
    } }),
  };
}
function item(queries: DataFacts["capabilityResults"]) {
  const diagnosis: DataDiagnosis = { evidence: { observations: [], facts: { services: {}, capabilityResults: queries } },
    findings: [], coverage: [{ goal: "business-data-relations", status: "sufficient", missingEvidence: [] }] };
  return { bizId: "biz-1", status: CommandStatus.Ok, artifacts: [], diagnosis };
}

test("data summary preserves composite sources, global addresses and producer-selected state", () => {
  const first = query("one"), duplicate = query("two"), changed = query("three", "failed");
  const items = [item([first, duplicate, changed])];
  const source = { services: {}, capabilityResults: [query("unrelated"), first, duplicate, changed] };
  const model = projectDataSummary(items, source)[0]!;
  expect(model.records).toHaveLength(2);
  expect(model.records[0]!.references).toEqual(["capabilityResults.1.result.facts.0", "capabilityResults.2.result.facts.0"]);
  const md = buildDataEvidenceSummary(items, source);
  const terminal = buildDataEvidenceSummary(items, source, false);
  for (const text of [md, terminal]) {
    expect(text).toContain("run\\_id: run-1");
    expect(text).toContain("status=running");
    expect(text).toContain("status=failed");
    expect(text).toContain("attempt=0");
    expect(text).toContain("finished=false");
    expect(text).toContain("采集状态：ok");
    expect(text).toContain("未发现已内置异常");
    expect(text).not.toContain("healthy");
    expect(text).not.toContain("not-a-display-field");
    expect(text).not.toContain("missing=");
    expect(text).not.toContain("undefined");
  }
});

test("summary bounds record output while keeping raw evidence and coverage gaps", () => {
  const data = item(Array.from({ length: 25 }, (_, i) => query(String(i), String(i))));
  data.diagnosis = { ...data.diagnosis, coverage: [{ goal: "business-data-relations", status: "partial", missingEvidence: ["runtime unavailable"] }] };
  const md = buildDataEvidenceSummary([data]);
  expect(md).toContain("另有 5 条记录");
  expect(md).toContain("runtime unavailable");
  expect(md).toContain("采集状态：partial");
  expect(md).toContain("[完整 Facts](raw/facts.json)");
});

test("trace summary bounds and orders exception events instead of calling the earliest a root cause", () => {
  const stats = newTraceStats();
  for (let i = 24; i >= 0; i--) accumulateStats(stats, [{ spanID: String(i), operationName: "model", startTimeMillis: i * 1000,
    duration: 1000, process: { serviceName: "agent" }, tags: [{ key: "error", value: true }],
    logs: [{ timestamp: (i * 1000 + 1) * 1000, fields: [{ key: "exception.message", value: "<script>failure</script>" }] }] }]);
  expect(stats.errorSpans).toBe(25);
  expect(stats.errors).toHaveLength(20);
  expect(stats.errors![0]!.spanId).toBe("0");
  const summary = buildTraceSummary({ traceId: "trace", index: "test", channel: "file", count: 25, downloaded: 25, stats, steps: [] });
  expect(summary).toContain("## 异常时间线");
  expect(summary).toContain("时间先后不代表根因关系");
  expect(summary).toContain("另有 5 个 error span");
  expect(summary).not.toContain("<script>");
});


test("a large record group cannot crowd runtime state out of the bounded summary", () => {
  const timeline = Array.from({ length: 25 }, (_, i) => query(`step-${i}`, String(i)));
  const runtime = { ...query("runtime", "waiting"), service: "runtime-service" };
  const md = buildDataEvidenceSummary([item([...timeline, runtime])]);
  expect(md).toContain("runtime-service / Run / run-1");
  expect(md).toContain("status=waiting");
  expect(md).toContain("另有 6 条记录");
  expect(md.indexOf("### 诊断发现")).toBeLessThan(md.indexOf("### 业务记录"));
});


test("summary preserves failed and cancelled collection outcomes", () => {
  for (const status of [CommandStatus.Failed, CommandStatus.Cancelled]) {
    const text = buildDataEvidenceSummary([{ bizId: "biz-1", status, artifacts: [], reason: "collection stopped" }]);
    expect(text).toContain(`采集状态：${status}`);
    expect(text).toContain("collection stopped");
    expect(text).toContain("未形成业务诊断");
  }
});
