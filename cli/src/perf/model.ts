import type { Run } from "@compforge/perf-harness";
import type { ServiceCaseFacetSpec } from "@compforge/doctor-plugin";

export interface PerfCliOpts {
  service?: string;
  scenario?: string;
  levels?: string;
  ramp?: string;
  hold?: string;
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

export type PerfOutputFormat = "html" | "bundle";

export interface PerfConfig {
  service?: string;
  scenario?: string;
  levels: number[];
  rampSeconds: number;
  holdSeconds: number;
  maxRequests: number;
  abortErrorRate: number;
  breakerMinN: number;
  gracefulStopSeconds: number;
  requestTimeoutMs: number;
  traceSamples: number;
  outputFormat: PerfOutputFormat;
  bundleName: string;
  outputDir: string;
}

export interface PerfEvidenceSample {
  trialId: string;
  caseId?: string;
  correlationKey: string;
  correlationId: string;
  firstTokenMs?: number;
  durationMs: number;
  errorKind?: string;
  tracePath: string;
  traceCode: number;
  logPath: string;
  logCode: number;
}

export interface PerfResult {
  run: Run;
  outputDir: string;
  metricPath: string;
  metricCode: number;
  samples: PerfEvidenceSample[];
  caseFacets?: Readonly<Record<string, ServiceCaseFacetSpec>>;
}
