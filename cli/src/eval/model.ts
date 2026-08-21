import type {
  ServiceCaseObservation,
  ServiceCaseVerdict,
} from "@compforge/doctor-plugin";

export interface EvalCliOpts {
  service?: string;
  caseset?: string;
  cases?: string;
  requestTimeout?: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
  yes?: boolean;
}

export interface EvalConfig {
  service?: string;
  caseset?: string;
  caseIds?: readonly string[];
  requestTimeoutMs: number;
  bundleName: string;
}

export interface EvalCorrelation {
  key: string;
  id: string;
}

export interface EvalCaseResult {
  caseId: string;
  facets?: Readonly<Record<string, string>>;
  startedAt: string;
  finishedAt: string;
  observation?: ServiceCaseObservation;
  protocol?: ServiceCaseVerdict;
  correlation?: EvalCorrelation;
  error?: string;
}

export type EvalEvidenceStatus = "collected" | "unavailable" | "failed";

export interface EvalEvidenceResult {
  status: EvalEvidenceStatus;
  exitCode?: number;
  reason?: string;
}

export interface EvalEvidenceCollection {
  trace: EvalEvidenceResult;
  log: EvalEvidenceResult;
  data: EvalEvidenceResult;
}

export interface EvalRun {
  schema: "doctor-eval/v1";
  runId: string;
  plugin: string;
  service: string;
  caseset: string;
  startedAt: string;
  finishedAt: string;
  cases: readonly EvalCaseResult[];
  evidence: EvalEvidenceCollection;
}
