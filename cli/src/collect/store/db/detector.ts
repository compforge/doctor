import type { Detector, DiagnosisCoverage } from "../../protocol";
import { detectMysqlFindings } from "../mysql-diagnosis";
import type { DbDiagnosisGoal, DbEvidence, DbFinding } from "./model";
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
    // 缺失证据由 Coverage 表达；Detector 不能把“没采到”误判成“查询不健康”。
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

export function buildDbCoverage(evidence: DbEvidence): DiagnosisCoverage<DbDiagnosisGoal>[] {
  const observations = groupDbObservations(evidence.observations);
  const accessReason = evidence.facts.access.status === "collected" ? undefined : evidence.facts.access.reason;
  const coverage = <Goal extends DbDiagnosisGoal>(goal: Goal, present: boolean, label: string) => ({
    goal,
    status: present ? "sufficient" as const : "insufficient" as const,
    missingEvidence: present ? [] : [accessReason ?? `${label} 未取得`],
  });
  return [
    coverage("health", !!observations.health, "DB 健康证据"),
    coverage("capacity", !!observations.capacity, "schema 容量"),
    coverage("load", !!observations.load, "窗口负载"),
    coverage("lock-waits", !!observations.lockWaits, "事务锁等待"),
  ];
}
