import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type { ServiceMetricCapability } from "@compforge/doctor-plugin";
import {
  PROBE_RUNNABLE,
  probeUnavailable,
  type Probe,
  type UpstreamProbeResult,
} from "../../protocol";
import type {
  MetricCollectContext,
  MetricConfig,
  MetricInspectionFacts,
  MetricObservation,
  MetricQueryObservation,
  MetricWindowObservation,
} from "../model";
import {
  buildMetricQueryPlans,
  instantMetricSeries,
  matrixMetricSeries,
} from "../query";

const WINDOW_PROBE_ID = "metric-window";

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function collectEmbeddedWindow(
  ctx: MetricCollectContext,
  config: MetricConfig,
): Promise<string[]> {
  if (!ctx.embeddedSource) throw new Error("embedded metric source 未准备");
  const errors: string[] = [];
  const scrape = async () => {
    for (const error of await ctx.embeddedSource!.scrapeOnce()) {
      if (!errors.includes(error)) errors.push(error);
    }
  };
  await scrape();
  if (config.watch.mode === "snapshot") return errors;
  const deadline = config.watch.mode === "duration"
    ? Date.now() + config.watch.durationMs
    : Number.POSITIVE_INFINITY;
  while (!ctx.signal.aborted && Date.now() < deadline) {
    await abortableDelay(Math.min(config.intervalMs, deadline - Date.now()), ctx.signal);
    if (!ctx.signal.aborted) await scrape();
  }
  return errors;
}

/**
 * 封口统一查询窗口：embedded 在这里把 /metrics 抓入 Prombed，remote 的历史数据已在外部 TSDB。
 * 下游 query Probe 因而只依赖 MetricQuerySource，不再分辨数据来自哪里。
 */
export function makeMetricWindowProbe(): Probe<
  MetricObservation,
  MetricInspectionFacts,
  MetricConfig,
  MetricCollectContext
> {
  return {
    id: WINDOW_PROBE_ID,
    evaluate: (facts) => facts.source.status === "collected"
      ? PROBE_RUNNABLE
      : probeUnavailable(facts.source.reason),
    onUnavailable: (ctx, reason) => ctx.bundle.fill(WINDOW_PROBE_ID, { status: "unavailable", reason }),
    run: async (ctx, _facts, config) => {
      let startedAt: number;
      let finishedAt: number;
      let scrapeErrors: string[] = [];
      if (ctx.sourceKind === "remote") {
        if (config.watch.mode === "until-interrupt") {
          startedAt = Date.now();
          await waitForAbort(ctx.signal);
          finishedAt = Date.now();
        } else {
          finishedAt = Date.now();
          startedAt = config.watch.mode === "duration"
            ? finishedAt - config.watch.durationMs
            : finishedAt;
        }
      } else {
        startedAt = Date.now();
        scrapeErrors = await collectEmbeddedWindow(ctx, config);
        finishedAt = Date.now();
        if (config.watch.mode === "snapshot") startedAt = finishedAt;
      }
      const observation: MetricWindowObservation = {
        id: WINDOW_PROBE_ID,
        kind: "metric-window",
        source: ctx.sourceKind,
        startedAt,
        finishedAt,
        scrapeErrors,
      };
      ctx.bundle.fill(WINDOW_PROBE_ID, {
        status: "ok",
        output: `${JSON.stringify(observation, null, 2)}\n`,
        ext: "json",
      });
      return [observation];
    },
  };
}

function windowFrom(
  progress: readonly UpstreamProbeResult<MetricObservation>[],
): MetricWindowObservation | undefined {
  return progress.flatMap((item) => item.observations).find(
    (item): item is MetricWindowObservation => item.kind === "metric-window",
  );
}

function serviceProbeId(service: string): string {
  return `metric-query-${service}`;
}

function makeMetricServiceProbe(
  service: string,
  capability: ServiceMetricCapability,
): Probe<MetricObservation, MetricInspectionFacts, MetricConfig, MetricCollectContext> {
  const id = serviceProbeId(service);
  return {
    id,
    dependsOn: [WINDOW_PROBE_ID],
    evaluate: (facts, _config, progress) => {
      if (facts.source.status !== "collected") return probeUnavailable(facts.source.reason);
      return windowFrom(progress) ? PROBE_RUNNABLE : probeUnavailable("Metric 采集窗口未形成");
    },
    onUnavailable: (ctx, reason) => ctx.bundle.fill(id, { status: "unavailable", reason }),
    run: async (ctx, _facts, config, progress) => {
      const window = windowFrom(progress)!;
      const plans = buildMetricQueryPlans({
        service,
        capability,
        startedAt: window.startedAt,
        finishedAt: window.finishedAt,
        intervalMs: config.intervalMs,
        watched: config.watch.mode !== "snapshot",
      });
      const observations = await Promise.all(plans.map(async (plan): Promise<MetricQueryObservation> => {
        try {
          const series = plan.queryKind === "range"
            ? matrixMetricSeries((await ctx.source.queryRange(
                plan.expression,
                window.startedAt,
                window.finishedAt,
                config.intervalMs,
              )).data.result)
            : instantMetricSeries(
                (await ctx.source.query(plan.expression, window.finishedAt)).data,
                window.finishedAt,
              );
          return {
            ...plan,
            kind: "metric-query",
            service,
            status: series.some((item) => item.points.length) ? "collected" : "empty",
            series,
          };
        } catch (error) {
          return {
            ...plan,
            kind: "metric-query",
            service,
            status: "failed",
            series: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      const failed = observations.filter((item) => item.status === "failed");
      ctx.bundle.fill(id, {
        status: failed.length === observations.length && observations.length > 0 ? "failed" : "ok",
        reason: failed.length === observations.length && failed.length > 0
          ? failed.map((item) => item.error).join("；")
          : undefined,
        output: `${JSON.stringify(observations, null, 2)}\n`,
        ext: "json",
      });
      return observations;
    },
  };
}

export function makeMetricProbes(
  services: readonly string[],
  catalog: ServiceCatalog,
): Array<Probe<MetricObservation, MetricInspectionFacts, MetricConfig, MetricCollectContext>> {
  return [
    makeMetricWindowProbe(),
    ...services.map((service) => {
      const declared = catalog.findWith(service, "metric");
      if (!declared) throw new Error(`Doctor 未注册 Service '${service}' 的 metric capability`);
      return makeMetricServiceProbe(service, declared.capabilities.metric);
    }),
  ];
}
