import { inspectMetricSamples, observationSampleInputs } from "@compforge/harness-toolbox/metricdb";
import type { MetricQualityBaseline } from "@compforge/perf-harness";
import type { PreparedPerfMetrics } from "./observations";
import { diagnosticMessage } from "../command/diagnostic";

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
      if (summary) inputs.push({service:probe.service, operation:probe.target, metric, ...observationSampleInputs(summary.promql)});
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

export function metricBaselineAdvice(metricBaseline: MetricQualityBaseline): string[] {
  const advice: string[] = [];
  const byService = new Map<string, Map<string,boolean>>();
  for (const input of metricBaseline.inputs) {
    const selectors = byService.get(input.service) ?? new Map<string,boolean>();
    for (const selector of input.selectors) selectors.set(selector, input.windowed || !!selectors.get(selector));
    byService.set(input.service, selectors);
  }
  for (const [serviceName, selectors] of byService) {
    const samples = [...selectors.keys()].map(selector => metricBaseline.samples[selector]);
    const sparse = [...selectors].filter(([selector, windowed]) => {
      const result = metricBaseline.samples[selector];
      return windowed && result && "series" in result && result.series > 0 && (result.minSamples ?? 0) < 2;
    }).length;
    const empty = samples.filter(result => result && "series" in result && result.series === 0).length;
    const unknown = samples.filter(result => !result || "error" in result).length;
    if (sparse || empty || unknown) advice.push(
      `${serviceName} 指标基线：${sparse} 个 selector 样本不足，${empty} 个未匹配时序，${unknown} 个未能核对。详见「指标质量」。`);
  }
  return advice;
}
