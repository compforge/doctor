import type { Experiment, Run } from "@compforge/perf-harness";
import type { CommandContext } from "../command";
import { writeOutput } from "../terminal/output";

/** @spec Progress observes existing runner calls; scheduling and final statistics remain Harness-owned. */
export class PerfProgress {
  readonly stop = new AbortController();
  #started = 0;
  #sent = 0;
  #settled = 0;
  #timer?: ReturnType<typeof setInterval>;
  #releaseInterrupt?: () => void;
  constructor(private readonly write: (text: string) => void = text => writeOutput(text, process.stderr)) {}

  observe(adapter: Pick<Experiment, "runner" | "judge">): Pick<Experiment, "runner" | "judge"> {
    if (!adapter.runner) return adapter;
    const runner = adapter.runner;
    return { ...adapter, runner: { ...runner, fire: async context => {
      this.#sent++;
      try { return await runner.fire(context); }
      finally { this.#settled++; }
    } } };
  }

  start(context: CommandContext): void {
    this.#started = performance.now();
    this.#sent = this.#settled = 0;
    this.#releaseInterrupt = context.onInterrupt(() => this.finish());
    this.#timer = setInterval(() => this.print(), 5000);
    this.#timer.unref();
    this.print();
  }

  /** Repeated Ctrl+C while draining never turns a graceful stop into command cancellation. */
  finish(): void {
    if (!this.stop.signal.aborted) {
      this.stop.abort();
      this.write(`[perf] 已结束本轮观测，停止新增请求；等待 ${this.#sent - this.#settled} 个在途请求收尾后采集指标并生成报告。\n`);
    } else this.write("[perf] 正在收尾并准备报告，请稍候。\n");
  }

  print(): void {
    const elapsed = ((performance.now() - this.#started) / 1000).toFixed(1);
    this.write(`[perf] ${this.stop.signal.aborted ? "收尾中" : "执行中"} ${elapsed}s，注入请求：已发出 ${this.#sent}，已结束 ${this.#settled}，在途 ${this.#sent - this.#settled}\n`);
  }

  requestsFinished(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.write("[perf] 请求阶段已结束，正在整理运行窗口与采集指标…\n");
  }

  dispose(): void {
    clearInterval(this.#timer);
    this.#releaseInterrupt?.();
  }
}

/** Summary uses realized Harness windows, including calls completed during drain. */
export function formatPerfSummary(run: Run, metricIssues: readonly string[] = []): string {
  const lines = ["[perf] 本轮结果："];
  for (const arm of run.executions) {
    const full = arm.windows.find(window => window.kind === "full");
    const hold = arm.phases.filter(phase => phase.kind === "hold").reduce((sum, phase) => sum + phase.end_s - phase.start_s, 0);
    const request = full?.request;
    lines.push(`  结束原因=${arm.stop.reason}，实际 hold=${hold.toFixed(2)}s；注入发出=${request?.dispatched ?? 0}，完成=${request?.completed ?? 0}，成功=${request?.n_ok ?? 0}，中断=${arm.stop.interrupted}`);
    if (request?.n) lines.push(`  请求耗时 P50=${request.p50_ms?.toFixed(1) ?? "N/A"}ms，P95=${request.p95_ms?.toFixed(1) ?? "N/A"}ms`);
  }
  if (metricIssues.length) {
    lines.push(`  指标覆盖不完整：${metricIssues.length} 项缺口`);
    lines.push(...metricIssues.slice(0, 5).map(issue => `    ${issue}`));
    if (metricIssues.length > 5) lines.push(`    其余 ${metricIssues.length - 5} 项见报告中的指标覆盖明细。`);
  }
  else lines.push(run.executions.some(arm => arm.prometheus_observations?.length)
    ? "  指标采集无已知缺口。" : "  本轮未产生指标查询。");
  return lines.join("\n") + "\n";
}
