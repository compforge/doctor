import type { PerfScrape } from "./scrape";
import type { FacetSpec } from "@compforge/spec-case/model";
import type { Run } from "@compforge/perf-harness";

export interface PerfCliOpts {

  service?: string;
  operation?: string;
  caseset?: string;
  cases?: string;
  caseDataset?: string;
  qps?: string;
  maxInflight?: string;
  ramp?: string;
  hold?: string;
  /** Removed in Harness 0.1; retained only to reject stale embedded inputs explicitly. */
  maxRequests?: string;
  abortErrorRate?: string;
  breakerMinN?: string;
  gracefulStop?: string;
  requestTimeout?: string;
  from?: string;
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
  qps: number;
  maxInflight?: number;
  rampSeconds: number;
  holdSeconds: number;
  abortErrorRate: number;
  breakerMinN: number;
  gracefulStopSeconds: number;
  requestTimeoutMs: number;
  outputFormat: PerfOutputFormat;
  bundleName: string;
}

export interface PerfResult {
  run: Run;
  outputDir: string;
  metricsComplete: boolean;
  scrape?: PerfScrape;
  metricIssues?: readonly string[];
  caseFacets?: Readonly<Record<string, FacetSpec>>;
}
