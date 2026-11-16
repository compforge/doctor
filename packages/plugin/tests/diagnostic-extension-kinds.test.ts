import { expect, test } from "bun:test";
import {
  FACET_SUMMARIZE_KIND, FACET_SAMPLE_KIND, DURATION_SUMMARIZE_KIND,
  requireFacetSummarizeExtension, requireFacetSampleExtension, requireDurationSummarizeExtension,
  requireHealthCaseExtension, withSummary,
} from "../src";

const summary = { title: "Fixture", fields: [] };
const contracts = [
  {
    kind: FACET_SUMMARIZE_KIND, expected: "facet.summarize", previous: "overview.summarize",
    extension: { id: "summary", kind: FACET_SUMMARIZE_KIND, access: {},
      facets: [{ id: "errors", title: "Errors", description: "Errors in the query window" }],
      run: withSummary(summary, async () => []) },
    require: requireFacetSummarizeExtension,
  },
  {
    kind: FACET_SAMPLE_KIND, expected: "facet.sample", previous: "overview.sample",
    extension: { id: "sample", kind: FACET_SAMPLE_KIND, access: {}, run: withSummary(summary, async () => []) },
    require: requireFacetSampleExtension,
  },
  {
    kind: DURATION_SUMMARIZE_KIND, expected: "duration.summarize", previous: "overview.cost",
    extension: { id: "duration", kind: DURATION_SUMMARIZE_KIND, access: {},
      run: withSummary(summary, async () => ({ description: "Completed intervals", entries: [] })) },
    require: requireDurationSummarizeExtension,
  },
  {
    kind: "healthcheck.biz", expected: "healthcheck", previous: "health.case.bindings",
    extension: { id: "bindings", kind: "healthcheck.biz", execution: "cases", description: "Bindings", access: {},
      run: withSummary(summary, async () => ({ bindings: [] })) },
    require: requireHealthCaseExtension,
  },
] as const;

for (const contract of contracts) {
  test(`${contract.expected} is exported and validated without a legacy alias`, () => {
    expect(contract.kind).toContain(contract.expected);
    expect(contract.require(contract.extension)).toBe(contract.extension);
    expect(() => contract.require({ ...contract.extension, kind: contract.previous })).toThrow(contract.expected);
  });
}
