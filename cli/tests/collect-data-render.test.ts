import { expect, test } from "bun:test";
import { buildDataCoverage } from "../src/collect/data/detector";
import { buildDataHtml } from "../src/collect/data/render";
import type { DataDiagnosis, DataEvidence } from "../src/collect/data";

test("Data Coverage 保留 capability Fact 的失败原因", () => {
  const evidence: DataEvidence = {
    observations: [],
    facts: {
      services: {
        sample: {
          target: {
            status: "collected",
            service: "sample",
            endpoint: "http://sample",
            database: "sample",
            username: "reader",
            credentialSource: "test",
          },
          inspect: { status: "collected", queryable: true },
        },
      },
      capabilityResults: [{
        id: "data-query:provide:sample:biz_id:biz-1",
        status: "failed",
        stage: "provide",
        service: "sample",
        identity: { kind: "biz_id", value: "biz-1" },
        reason: "query timeout",
      }],
    },
  };

  expect(buildDataCoverage(evidence)).toEqual([{
    goal: "business-data-relations",
    status: "insufficient",
    missingEvidence: ["sample 业务记录未取得：biz_id:biz-1: query timeout"],
  }]);
});

test("Data HTML 将已解析的业务结果交给懒加载分页表格并安全序列化 JSON", () => {
  const cardResult = {
    kind: "example-card",
    service: "example-service",
    resolution: { inputId: "card-1", resolvedAs: "card_id" },
    card: { title: "</script><script>alert(1)</script>" },
  };
  const unresolvedResult = {
    kind: "other-records",
    service: "other-service",
    resolution: { inputId: "card-1", resolvedAs: "unresolved" },
    hidden: "unresolved-result",
  };
  const diagnosis: DataDiagnosis = {
    evidence: {
      observations: [],
      facts: {
        services: {},
      capabilityResults: [
          {
            id: "data-query:provide:example-service:card_id:card-1",
            status: "collected",
            stage: "provide",
            service: "example-service",
            identity: { kind: "card_id", value: "card-1" },
            result: {
              resolution: {
                inputId: "card-1",
                resolvedAs: "card_id",
                identifiers: { card_id: "card-1" },
              },
              facts: [{ factType: "value", kind: "example-card", schemaVersion: 1, value: cardResult }],
            },
          },
          {
            id: "data-query:provide:other-service:biz_id:card-1",
            status: "collected",
            stage: "provide",
            service: "other-service",
            identity: { kind: "biz_id", value: "card-1" },
            result: {
              resolution: { inputId: "card-1", resolvedAs: "unresolved", identifiers: {} },
              facts: [{ factType: "value", kind: "other-records", schemaVersion: 1, value: unresolvedResult }],
            },
          },
        ],
      },
    },
    findings: [],
    coverage: [{ goal: "business-data-relations", status: "partial", missingEvidence: [] }],
  };

  const html = buildDataHtml(diagnosis);

  expect(html).toContain("<h2>业务数据</h2>");
  expect(html).toContain('<details class="table-view">');
  expect(html).toContain("搜索业务数据关键字");
  expect(html).toContain("example-service");
  expect(html).toContain("example-card");
  expect(html).toContain('"headers":[{"display":"key","sortType":"text"},{"display":"data","sortType":"text"}');
  expect(html).toContain('{"display":"type","sortType":"text"},{"display":"resolved as","sortType":"text"},{"display":"service","sortType":"text"}');
  expect(html).toContain('"detailTitle":"example-card · —"');
  expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
  expect(html).not.toContain("</script><script>alert(1)</script>");
  expect(html).not.toContain("unresolved-result");
});
