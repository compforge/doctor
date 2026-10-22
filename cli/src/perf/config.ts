import type { LoadPlan, Stage } from "@compforge/perf-harness";
import { join } from "node:path";
import type { PerfCliOpts, PerfConfig, PerfOutputFormat } from "./model";

export const PERF_MAX_CONCURRENCY_OPTIONS = [1, 5, 10, 20, 50] as const;
export const MAX_PERF_CONCURRENCY = 50;

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

export function parsePerfLevels(raw = "5,10,15,20"): number[] {
  const levels = [...new Set(raw.split(",").map((item) => Number(item.trim())))];
  if (
    !levels.length
    || levels.some((level) => !Number.isInteger(level) || level < 1 || level > MAX_PERF_CONCURRENCY)
  ) {
    throw new Error(`--levels 必须是逗号分隔的 1-${MAX_PERF_CONCURRENCY} 整数，例如 5,10,15,20`);
  }
  return levels;
}

export function perfLevelsThrough(maxConcurrency: number): number[] {
  if (!PERF_MAX_CONCURRENCY_OPTIONS.includes(
    maxConcurrency as (typeof PERF_MAX_CONCURRENCY_OPTIONS)[number],
  )) {
    throw new Error(`最高并发只支持 ${PERF_MAX_CONCURRENCY_OPTIONS.join("、")}`);
  }
  if (maxConcurrency === 1) return [1];
  return Array.from({ length: maxConcurrency / 5 }, (_, index) => (index + 1) * 5);
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
  if (opts.maxRequests !== undefined) throw new Error("Perf Harness 0.1 已移除 --max-requests；请使用 --levels、--ramp、--hold 和 --abort-error-rate 控制负载");
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
    service: opts.service?.trim() || undefined,
    scenario: opts.scenario?.trim() || undefined,
    levels: parsePerfLevels(opts.levels),
    rampSeconds: seconds(opts.ramp, 10, "--ramp"),
    holdSeconds: seconds(opts.hold, 60, "--hold"),
    abortErrorRate: fraction(opts.abortErrorRate, 0.1, "--abort-error-rate"),
    breakerMinN: integer(opts.breakerMinN, 10, "--breaker-min-n", 1),
    gracefulStopSeconds: seconds(opts.gracefulStop, 60, "--graceful-stop"),
    requestTimeoutMs: integer(opts.requestTimeout, 180, "--request-timeout", 1) * 1000,
    traceSamples: integer(opts.traceSamples, 10, "--trace-samples", 0),
    outputFormat,
    bundleName,
  };
}

/** Saturated load uses concurrency as its only pacing axis; each level has an explicit ramp and hold. */
export function perfLoadPlans(config: PerfConfig): LoadPlan[] {
  if (config.holdSeconds + config.rampSeconds <= 0) throw new Error("--ramp 与 --hold 不能同时为 0");
  return config.levels.map(level => {
    const stages: Stage[] = [];
    if (config.rampSeconds > 0) stages.push({
      kind: "ramp", request_rate: Infinity, max_inflight: level, duration_s: config.rampSeconds,
    });
    if (config.holdSeconds > 0) stages.push({
      kind: "hold", request_rate: Infinity, max_inflight: level, duration_s: config.holdSeconds,
    });
    return {
      request_rate: Infinity,
      max_inflight: config.rampSeconds > 0 ? 1 : level,
      hold_s: config.holdSeconds || config.rampSeconds,
      stages,
      abort_on_error_rate: config.abortErrorRate,
      breaker_min_n: config.breakerMinN,
      cooldown_timeout_s: config.gracefulStopSeconds,
    };
  });
}
