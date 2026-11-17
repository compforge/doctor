import type { LoadPlan, Stage } from "@compforge/perf-harness";
import { join } from "node:path";
import type { PerfCliOpts, PerfConfig, PerfOutputFormat } from "./model";

function integer(value: string | undefined, fallback: number, label: string, minimum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} 必须是 >= ${minimum} 的整数`);
  }
  return parsed;
}

function seconds(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} 必须是 >= 0 的秒数`);
  return parsed;
}

function fraction(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${label} 必须在 (0, 1] 范围内`);
  }
  return parsed;
}

export function perfRunName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `doctor-perf-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function parsePerfOutputFormat(value: string | undefined): PerfOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "html" && format !== "bundle") {
    throw new Error(`--format 只支持 html 或 bundle: '${format}'`);
  }
  return format;
}

export function resolvePerfConfig(opts: PerfCliOpts, now = new Date()): PerfConfig {
  if (opts.maxRequests !== undefined) throw new Error("Perf Harness 0.1 已移除 --max-requests；请使用 --qps、--max-inflight、--hold 和 --abort-error-rate 控制负载");
  const outputFormat = parsePerfOutputFormat(opts.format);
  const bundleName = perfRunName(now);
  const outputCandidate = opts.output?.trim() || join(".", bundleName);
  const outputDir = outputFormat === "default"
    ? outputCandidate
      .replace(/\.tar\.gz$/i, "")
      .replace(/\.tgz$/i, "")
      .replace(/\.html$/i, "")
    : outputCandidate;
  if (outputFormat === "html" && /\.(?:tar\.gz|tgz)$/i.test(outputDir)) {
    throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz 后缀");
  }
  if (outputFormat === "bundle" && /\.html$/i.test(outputDir)) {
    throw new Error("--format bundle 的输出路径不能使用 .html 后缀");
  }
  return {
    qps: seconds(opts.qps, 0, "--qps"),
    maxInflight: seconds(opts.qps, 0, "--qps") > 0 ? integer(opts.maxInflight, 20, "--max-inflight", 1) : undefined,
    rampSeconds: seconds(opts.ramp, 10, "--ramp"),
    holdSeconds: seconds(opts.hold, 60, "--hold"),
    abortErrorRate: fraction(opts.abortErrorRate, 0.1, "--abort-error-rate"),
    breakerMinN: integer(opts.breakerMinN, 10, "--breaker-min-n", 1),
    gracefulStopSeconds: seconds(opts.gracefulStop, 60, "--graceful-stop"),
    requestTimeoutMs: integer(opts.requestTimeout, 180, "--request-timeout", 1) * 1000,
    outputFormat,
    bundleName,
  };
}

/** Injection rate and full-request concurrency are independent controls. */
export function perfLoadPlans(config: PerfConfig): LoadPlan[] {
  if (config.holdSeconds <= 0) throw new Error("--hold 必须大于 0");
  if (config.qps === 0) return [{request_rate: 0, hold_s: config.holdSeconds, cooldown_timeout_s: 0}];
  const stages: Stage[] = [];
  if (config.qps > 0 && config.rampSeconds > 0) stages.push({
    kind: "warmup", shape: "ramp", request_rate: config.qps,
    max_inflight: config.maxInflight!, duration_s: config.rampSeconds,
  });
  stages.push({kind: "hold", request_rate: config.qps, max_inflight: config.maxInflight!, duration_s: config.holdSeconds});
  return [{request_rate: config.qps > 0 && config.rampSeconds > 0 ? Math.min(1, config.qps) : config.qps,
    max_inflight: config.maxInflight, hold_s: config.holdSeconds, stages,
    abort_on_error_rate: config.abortErrorRate, breaker_min_n: config.breakerMinN,
    cooldown_timeout_s: config.qps === 0 ? 0 : config.gracefulStopSeconds}];
}
