import { expect, test } from "bun:test";
import { buildDataHtml } from "../src/collect/data/render";
import type { DataDiagnosis } from "../src/collect/data";

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
      facts: { services: {} },
      observations: [
        {
          id: "data-records:provide:example-service:card-1",
          kind: "service-data-inspection",
          stage: "provide",
          service: "example-service",
          result: cardResult,
          summary: {
            resolvedAs: "card_id",
            identifiers: { card_id: "card-1" },
          },
        },
        {
          id: "data-records:provide:other-service:card-1",
          kind: "service-data-inspection",
          stage: "provide",
          service: "other-service",
          result: unresolvedResult,
          summary: { resolvedAs: "unresolved", identifiers: {} },
        },
      ],
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
