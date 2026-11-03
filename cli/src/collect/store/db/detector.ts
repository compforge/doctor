import { evidenceGaps, type EvidenceGapFinding } from "../../evidence-gaps";
import type { Detector, } from "../../protocol";
import { detectMysqlFindings } from "../mysql-diagnosis";
import type { DbEvidence, DbFinding } from "./model";
import { groupDbObservations } from "./model";

const SUMMARIES: Record<string, string> = {
  "db.query-unhealthy": "DB 只读查询健康检查失败。",
  "db.connections-exhausted": "DB 连接使用率已接近耗尽。",
  "db.connections-high": "DB 连接使用率偏高。",
  "db.connections-rejected": "采样窗口内观察到连接被拒绝。",
  "db.slow-queries-observed": "采样窗口内观察到慢查询增长。",
  "db.lock-waits-observed": "当前存在事务锁等待。",
};

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "db-health" },
};

export function detectDbFindings(evidence: DbEvidence): DbFinding[] {
  const observations = groupDbObservations(evidence.observations);
  return detectMysqlFindings({
    // 缺失证据由独立的证据不足 Finding 表达；Detector 不能把“没采到”误判成“查询不健康”。
    queryable: observations.health?.queryable ?? true,
    load: observations.load,
    locks: observations.lockWaits,
  }).map((finding, index) => {
    const source = finding.kind === "db.query-unhealthy"
      ? observations.health
      : finding.kind === "db.lock-waits-observed"
        ? observations.lockWaits
        : observations.load;
    return {
      ...FINDING_META,
      ...finding,
      id: `${finding.kind.replaceAll(".", "-")}-${index + 1}`,
      kind: finding.kind as `db.${string}`,
      confidence: "high" as const,
      evidence: source ? [{ observationId: source.id, role: "supporting" as const }] : [],
      summary: SUMMARIES[finding.kind] ?? finding.kind,
    };
  });
}

export const dbDetectors: readonly Detector<DbEvidence, DbFinding>[] = [detectDbFindings];

export function detectDbEvidenceGaps(evidence: DbEvidence): EvidenceGapFinding[] {
  const observations = groupDbObservations(evidence.observations);
  const accessReason = evidence.facts.access.status === "collected" ? undefined : evidence.facts.access.reason;
  const missing = (goal: string, present: boolean, label: string) => (evidenceGaps(goal, present ? [] : [accessReason ?? `${label} 未取得`], evidence));
  return [
    ...missing("health", !!observations.health, "DB 健康证据"),
    ...missing("capacity", !!observations.capacity, "schema 容量"),
    ...missing("load", !!observations.load, "窗口负载"),
    ...missing("lock-waits", !!observations.lockWaits, "事务锁等待"),
  ];
}
