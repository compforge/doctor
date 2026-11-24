import { expect, test } from "bun:test";
import { counterIncreaseFunction, type MetricDBReader } from "@compforge/harness-toolbox/metricdb";
import type { PrometheusProbe } from "@compforge/perf-harness";
import { inspectMetricBaseline, metricBaselineAdvice } from "../src/perf/quality";

for (const kind of ["prometheus", "victoriametrics"] as const) {
  test(`baseline warnings on ${kind} account for a zero-fallback numerator per Operation`, async () => {
    const probe = (name: string, mode: "fallback" | "required"): PrometheusProbe => {
      const target = `operation:api/${name}`;
      const both = `requests_total{path="/${name}",`;
      const numerator = `${both}status_code=~"5.."}`;
      const denominator = `${both}status_code!=""}`;
      const aggregate = (selector: string) => `sum(${counterIncreaseFunction[kind]}(${selector}[$window]))`;
      const total = aggregate(denominator);
      const failed = aggregate(numerator);
      const errorRate = mode === "fallback" ? `(${failed} or (0 * ${total})) / (${total} > 0)` : `${failed} / (${total} > 0)`;
      return { service:"api", target, metrics:{error_rate:`${target}.error_rate`, qps:`${target}.qps`},
        summaries:[
          {name:`${target}.error_rate`,promql:errorRate,unit:"ratio"},
          {name:`${target}.qps`,promql:`sum(rate(${denominator}[$window]))`,unit:"rps"},
        ] };
    };
    const source: MetricDBReader = {
      kind, url:"http://metrics",
      async query(expression) {
        const hasSamples = expression.includes('status_code!=""') && !expression.includes('"/idle"');
        const count = expression.includes('"/sparse"') ? "1" : "4";
        if (expression.includes('"/unavailable"') && hasSamples) throw new Error("fixture");
        return {data:{resultType:"vector",result:hasSamples ? [{metric:{samples:count},value:[0,"2"]}] : []},warnings:[],infos:[]};
      },
      async queryRange() { throw new Error("Unexpected range query"); },
    };
    const baseline = await inspectMetricBaseline({declared:true, source, issues:[], probes:[
      probe("healthy", "fallback"), probe("idle", "fallback"), probe("required", "required"),
      probe("sparse", "fallback"), probe("unavailable", "fallback"),
    ]}, 60, new AbortController().signal);

    expect(baseline!.samples['requests_total{path="/healthy",status_code=~"5.."}']).toEqual({series:0});
    expect(metricBaselineAdvice(baseline!, ["operation:api/required"])).toEqual([
      {level:"warn", message:"api 指标基线（回看 60s）：1 个入口 Operation 无匹配的必需时序（required）；1 个 Operation 样本不足（sparse）；1 个 Operation 未能核对（unavailable）。详见「指标质量」。"},
      {level:"info", message:"api 指标基线（回看 60s）：1 个非入口 Operation 在回看窗口内无匹配的必需时序（idle）。详见「指标质量」。"},
    ]);
  });
}
