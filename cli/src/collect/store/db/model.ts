import type { Diagnosis, Evidence, FindingMeta } from "../../protocol";
import type { MysqlCapacityFact, MysqlLoadFact, MysqlLockWaitFact, MysqlServerInfo } from "../mysql-diagnosis";
import type { DbInspectionFacts } from "./fact/model";

export interface DbHealthObservation {
  id: "db-health";
  kind: "db-health";
  queryable: boolean;
  connectionAndQueryLatencyMs: number;
  queryLatencyMs: number;
}
export interface DbServerInfoObservation extends MysqlServerInfo { id: "db-server-info"; kind: "db-server-info" }
export interface DbCapacityObservation extends MysqlCapacityFact { id: "db-capacity"; kind: "db-capacity" }
export interface DbLoadObservation extends MysqlLoadFact { id: "db-load"; kind: "db-load" }
export interface DbLockWaitObservation extends MysqlLockWaitFact { id: "db-lock-waits"; kind: "db-lock-waits" }

export type DbObservation = DbHealthObservation | DbServerInfoObservation | DbCapacityObservation | DbLoadObservation | DbLockWaitObservation;
export interface DbObservations {
  health?: DbHealthObservation;
  serverInfo?: DbServerInfoObservation;
  capacity?: DbCapacityObservation;
  load?: DbLoadObservation;
  lockWaits?: DbLockWaitObservation;
}
export type DbFindingKind = `db.${string}`;
export interface DbFinding extends FindingMeta<DbFindingKind> { summary: string; [key: string]: unknown }
export type DbDiagnosisGoal = "health" | "capacity" | "load" | "lock-waits";
export type DbEvidence = Evidence<DbObservation, DbInspectionFacts>;
export type DbDiagnosis = Diagnosis<DbEvidence, DbFinding, DbDiagnosisGoal>;

export function groupDbObservations(observations: readonly DbObservation[]): DbObservations {
  const find = <Kind extends DbObservation["kind"]>(kind: Kind) =>
    observations.find((item) => item.kind === kind) as Extract<DbObservation, { kind: Kind }> | undefined;
  return {
    health: find("db-health"),
    serverInfo: find("db-server-info"),
    capacity: find("db-capacity"),
    load: find("db-load"),
    lockWaits: find("db-lock-waits"),
  };
}
