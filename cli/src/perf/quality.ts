import { counterIncreaseFunction, inspectMetricSamples, observationSampleInputs } from "@compforge/harness-toolbox/metricdb";
import type { MetricQualityBaseline as HarnessMetricBaseline } from "@compforge/perf-harness";
import type { PreparedPerfMetrics } from "./observations";
import { diagnosticMessage } from "../command/diagnostic";

type MetricInput = HarnessMetricBaseline["inputs"][number] & {
  zeroFallbackNumerator?: string;
};

export type MetricQualityBaseline = Omit<HarnessMetricBaseline, "inputs"> & { inputs: MetricInput[] };

/** @rule An empty input is optional only for the proven zero-fallback formula and its own denominator. */
function zeroFallbackNumerator(promql: string, selectors: readonly string[], increase: string): string | undefined {
  const [numerator, denominator] = selectors;
  if (!numerator || !denominator || selectors.length !== 2) return;
  const aggregate = (selector: string) => `sum(${increase}(${selector}[$window]))`;
  const completed = aggregate(denominator);
  const withFallback = `(${aggregate(numerator)} or (0 * ${completed})) / (${completed} > 0)`;
  if (promql.trim() === withFallback) return numerator;
}

/** @rule Evaluate raw inputs at one pre-load timestamp. A failed or budget-limited read stays unknown. */
export async function inspectMetricBaseline(prepared: PreparedPerfMetrics, windowSeconds: number,
  commandSignal: AbortSignal): Promise<MetricQualityBaseline | undefined> {
  const source = prepared.source;
  if (!source) return;
  const inputs: MetricQualityBaseline["inputs"] = [];
  for (const probe of prepared.probes) {
    if (probe.scope === "workload" || probe.scope === "service") continue;
    const summaries = new Map(probe.summaries.map(summary => [summary.name, summary]));
    for (const [metric, key] of Object.entries(probe.metrics)) {
      const summary = summaries.get(key);
      if (!summary) continue;
      const sampleInputs = observationSampleInputs(summary.promql);
      const fallback = metric === "error_rate"
        ? zeroFallbackNumerator(summary.promql, sampleInputs.selectors, counterIncreaseFunction[source.kind])
        : undefined;
      inputs.push({service:probe.service, operation:probe.target, metric, ...sampleInputs, zeroFallbackNumerator:fallback});
    }
  }
  if (!inputs.length) return;
  const baseline: MetricQualityBaseline = {endTime:Date.now()/1000, windowSeconds, inputs, samples:Object.create(null)};
  const selectors = [...new Set(inputs.flatMap(input => input.selectors))];
  const signal = AbortSignal.any([commandSignal, AbortSignal.timeout(5000)]);
  let index = 0;
  const inspect = async () => {
    while (!signal.aborted && index < selectors.length) {
      const selector = selectors[index++]!;
      try { baseline.samples[selector] = await inspectMetricSamples(source, selector, baseline.endTime, windowSeconds, signal); }
      catch (error) {
        commandSignal.throwIfAborted();
        baseline.samples[selector] = {error:signal.aborted ? "基线探测超时" : diagnosticMessage(error)};
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(4,selectors.length)}, inspect));
  commandSignal.throwIfAborted();
  return baseline;
}

export function metricBaselineAdvice(baseline: MetricQualityBaseline): string[] {
  const byService = new Map<string, { empty: Set<string>; sparse: Set<string>; unknown: Set<string> }>();
  for (const input of baseline.inputs) {
    const gaps = byService.get(input.service) ?? { empty:new Set<string>(), sparse:new Set<string>(), unknown:new Set<string>() };
    byService.set(input.service, gaps);
    const operation = input.operation.slice(input.operation.lastIndexOf("/") + 1);
    for (const selector of input.selectors) {
      const samples = baseline.samples[selector];
      if (!samples || "error" in samples) {
        gaps.unknown.add(operation);
      } else if (samples.series === 0) {
        if (selector === input.zeroFallbackNumerator) continue;
        gaps.empty.add(operation);
      } else if (input.windowed && (samples.minSamples ?? 0) < 2) {
        gaps.sparse.add(operation);
      }
    }
  }

  const advice: string[] = [];
  for (const [service, {empty, sparse, unknown}] of byService) {
    const details = [
      [empty, "无匹配的必需时序"],
      [sparse, "样本不足"],
      [unknown, "未能核对"],
    ] as const;
    const warnings = details.flatMap(([operations, reason]) =>
      operations.size ? [`${operations.size} 个 Operation ${reason}（${[...operations].join("、")}）`] : []);
    if (warnings.length) advice.push(`${service} 指标基线（回看 ${baseline.windowSeconds}s）：${warnings.join("；")}。详见「指标质量」。`);
  }
  return advice;
}
