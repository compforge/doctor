import type { CommandResult } from "../command";
import type { FacetSpec } from "@compforge/spec-case/model";
import type { Run } from "@compforge/perf-harness";

export interface PerfCliOpts {
  service?: string;
  scenario?: string;
  caseFile?: string;
  caseset?: string;
  cases?: string;
  levels?: string;
  ramp?: string;
  hold?: string;
  /** Removed in Harness 0.1; retained only to reject stale embedded inputs explicitly. */
  maxRequests?: string;
  abortErrorRate?: string;
  breakerMinN?: string;
  gracefulStop?: string;
  requestTimeout?: string;
  traceSamples?: string;
  interval?: string;
  prometheus?: string;
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
  yes?: boolean;
}

export type PerfOutputFormat = "default" | "html" | "bundle";

export interface PerfConfig {
  service?: string;
  scenario?: string;
  levels: number[];
  rampSeconds: number;
  holdSeconds: number;
  abortErrorRate: number;
  breakerMinN: number;
  gracefulStopSeconds: number;
  requestTimeoutMs: number;
  traceSamples: number;
  outputFormat: PerfOutputFormat;
  bundleName: string;
}

export interface PerfEvidenceSample {
  armRunId: string;
  caseId?: string;
  correlationKey: string;
  correlationId: string;
  firstTokenMs?: number;
  durationMs: number;
  errorKind?: string;
  trace: CommandResult<unknown>;
  log?: CommandResult<unknown>;
}

export interface PerfResult {
  run: Run;
  outputDir: string;
  metric: CommandResult<void>;
  samples: PerfEvidenceSample[];
  caseFacets?: Readonly<Record<string, FacetSpec>>;
}
