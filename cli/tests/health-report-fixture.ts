import type { CaseCheckResult } from "../src/health/cases/run";
import type { HealthResult } from "../src/health/flow";
export function caseHealthReport(cases: CaseCheckResult[]): HealthResult {
  return { checkedAt: "now", query: {}, providers: [{ name: "sandbox", namespace: "sandbox", checks: [{
    id: "requests", scope: "biz", description: "Case checks", status: "failed", summary: "Case evidence", cases,
  }] }] };
}
