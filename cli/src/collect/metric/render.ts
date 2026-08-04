import { escapeHtml, htmlLineCharts, htmlPieCharts, type HtmlReportSection } from "../output/html";
import type { ServiceMetricChart } from "@compforge/doctor-plugin";
import type {
  MetricDiagnosis,
  MetricQueryObservation,
  MetricSeries,
  MetricWindowObservation,
} from "./model";

interface MetricChartResult {
  definition: ServiceMetricChart;
  series: MetricSeries[];
  error?: string;
}

interface MetricServiceResult {
  service: string;
  charts: MetricChartResult[];
}

function queryObservations(diagnosis: MetricDiagnosis): MetricQueryObservation[] {
  return diagnosis.evidence.observations.filter(
    (item): item is MetricQueryObservation => item.kind === "metric-query",
  );
}

function metricWindow(diagnosis: MetricDiagnosis): MetricWindowObservation | undefined {
  return diagnosis.evidence.observations.find(
    (item): item is MetricWindowObservation => item.kind === "metric-window",
  );
}

function serviceResults(diagnosis: MetricDiagnosis): MetricServiceResult[] {
  const services = new Map<string, MetricServiceResult>();
  for (const observation of queryObservations(diagnosis)) {
    let service = services.get(observation.service);
    if (!service) {
      service = { service: observation.service, charts: [] };
      services.set(observation.service, service);
    }
    for (const consumer of observation.consumers) {
      if (consumer.kind !== "chart") continue;
      service.charts.push({
        definition: consumer.definition,
        series: scaleSeries(observation.series, consumer.definition.unit),
        error: observation.status === "failed"
          ? observation.error ?? "PromQL 查询失败"
          : observation.status === "empty" ? "PromQL 未返回数据" : undefined,
      });
    }
  }
  return [...services.values()];
}

export function buildMetricSummary(diagnosis: MetricDiagnosis): string {
  const window = metricWindow(diagnosis);
  const source = diagnosis.evidence.facts.source.status === "collected"
    ? diagnosis.evidence.facts.source.backend
    : "不可用";
  const findingHtml = diagnosis.findings.length
    ? `<ul>${diagnosis.findings.map((finding) => `<li><strong>${escapeHtml(finding.severity)}</strong> · ${escapeHtml(finding.service)} · ${escapeHtml(finding.message)} 当前值 ${escapeHtml(finding.value.toFixed(2))}，阈值 ${escapeHtml(finding.threshold)}</li>`).join("")}</ul>`
    : "<p>未触发已注册 detector。</p>";
  const errors = [
    ...(window?.scrapeErrors ?? []),
    ...queryObservations(diagnosis).flatMap((observation) => observation.error ? [observation.error] : []),
    ...diagnosis.coverage.flatMap((item) => item.missingEvidence),
  ];
  const errorHtml = [...new Set(errors)]
    .map((error) => `<li>${escapeHtml(error)}</li>`).join("");
  return `<h1>Metric 诊断摘要</h1><p>数据源：${escapeHtml(source)}；窗口：${escapeHtml(formatWindow(window))}。</p><h2>Detector Findings</h2>${findingHtml}${errorHtml ? `<h2>采集缺口</h2><ul>${errorHtml}</ul>` : ""}`;
}

export function buildMetricSections(diagnosis: MetricDiagnosis): HtmlReportSection[] {
  return serviceResults(diagnosis).map((service) => ({
    id: `metric-${service.service.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    title: `${service.service} Metrics`,
    html: renderService(service),
  }));
}

function renderService(service: MetricServiceResult): string {
  const lineCharts = service.charts
    .filter((chart) => chart.definition.kind === "line")
    .map((chart) => ({
      title: chart.definition.title,
      description: chart.error ? `${chart.definition.description}（查询失败：${chart.error}）` : chart.definition.description,
      unit: unitLabel(chart.definition.unit),
      series: chart.series.map((series) => ({
        label: seriesLabel(series, chart.definition.label),
        points: series.points,
      })),
    }));
  const pieCharts = service.charts
    .filter((chart) => chart.definition.kind === "pie")
    .map((chart) => ({
      title: chart.definition.title,
      description: chart.error ? `${chart.definition.description}（查询失败：${chart.error}）` : chart.definition.description,
      slices: chart.series.flatMap((series) => {
        const value = series.points.at(-1)?.value;
        return value === undefined ? [] : [{
          label: seriesLabel(series, chart.definition.label),
          value,
          valueLabel: formatValue(value, chart.definition.unit),
        }];
      }),
    }));
  const contracts = service.charts.map((chart) => `<details><summary>${escapeHtml(chart.definition.title)} · PromQL</summary><p>${escapeHtml(chart.definition.description)}</p><pre><code>snapshot: ${escapeHtml(chart.definition.query.instant)}
watch: ${escapeHtml(chart.definition.query.range)}</code></pre></details>`).join("");
  return `${lineCharts.length ? htmlLineCharts(lineCharts) : ""}${pieCharts.length ? htmlPieCharts(pieCharts) : ""}<h3>Metric 声明</h3>${contracts}`;
}

function seriesLabel(series: MetricSeries, preferred?: string): string {
  if (preferred && series.labels[preferred]) return series.labels[preferred]!;
  const labels = Object.entries(series.labels)
    .filter(([name]) => !["__name__", "instance", "job", "doctor_service"].includes(name));
  return labels.length ? labels.map(([name, value]) => `${name}=${value}`).join(", ") : "overall";
}

function unitLabel(unit?: "seconds" | "percent" | "count"): string | undefined {
  if (unit === "seconds") return "s";
  if (unit === "percent") return "%";
  return unit === "count" ? "次" : undefined;
}

function formatValue(value: number, unit?: "seconds" | "percent" | "count"): string {
  if (unit === "percent") return `${value.toFixed(2)}%`;
  if (unit === "seconds") return `${value.toFixed(2)}s`;
  return unit === "count" ? `${value.toFixed(0)} 次` : String(value);
}

function scaleSeries(series: readonly MetricSeries[], unit?: ServiceMetricChart["unit"]): MetricSeries[] {
  const multiplier = unit === "percent" ? 100 : 1;
  return series.map((item) => ({
    labels: item.labels,
    points: item.points.map((point) => ({ ...point, value: point.value * multiplier })),
  }));
}

function formatWindow(window: MetricWindowObservation | undefined): string {
  if (!window) return "未形成";
  const durationMs = window.finishedAt - window.startedAt;
  return durationMs <= 0 ? "累计快照" : `${(durationMs / 1000).toFixed(1)}s`;
}
