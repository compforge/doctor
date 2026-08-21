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
      capabilityFacts: [{
        id: "data-fact:provide:sample:biz_id:biz-1",
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

test("Data HTML 直接展示已解析的业务结果并安全转义 JSON", () => {
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
        capabilityFacts: [
          {
            id: "data-fact:provide:example-service:card_id:card-1",
            status: "collected",
            stage: "provide",
            service: "example-service",
            identity: { kind: "card_id", value: "card-1" },
            fact: cardResult,
            summary: {
              resolvedAs: "card_id",
              identifiers: { card_id: "card-1" },
            },
          },
          {
            id: "data-fact:provide:other-service:biz_id:card-1",
            status: "collected",
            stage: "provide",
            service: "other-service",
            identity: { kind: "biz_id", value: "card-1" },
            fact: unresolvedResult,
            summary: { resolvedAs: "unresolved", identifiers: {} },
          },
        ],
      },
    },
    findings: [],
    coverage: [{ goal: "business-data-relations", status: "partial", missingEvidence: [] }],
  };

  const html = buildDataHtml(diagnosis);

  expect(html).toContain("<h2>业务数据</h2>");
  expect(html).toContain('<details class="data-result" open>');
  expect(html).toContain("example-service · provide · card-1 · card_id");
  expect(html).toContain("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("</script><script>alert(1)</script>");
  expect(html).not.toContain("unresolved-result");
});
