import { escapeHtml } from "./content";
import type { HtmlBarChartItem, HtmlLineChart, HtmlPieChart, HtmlReportSection } from "../model";

const PIE_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#dc2626", "#0891b2", "#64748b"];

export function htmlPieCharts(charts: readonly HtmlPieChart[]): string {
  const cards = charts.map((chart) => {
    const slices = chart.slices.filter((slice) => Number.isFinite(slice.value) && slice.value > 0);
    const total = slices.reduce((sum, slice) => sum + slice.value, 0);
    if (!total) {
      return `<article class="pie-card"><h3>${escapeHtml(chart.title)}</h3><p class="muted">无数据。</p></article>`;
    }
    let offset = 0;
    const gradients = slices.map((slice, index) => {
      const start = offset * 100 / total;
      offset += slice.value;
      const end = offset * 100 / total;
      return `${PIE_COLORS[index % PIE_COLORS.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    });
    const legend = slices.map((slice, index) => `
      <li><span class="swatch" style="background:${PIE_COLORS[index % PIE_COLORS.length]}"></span><span>${escapeHtml(slice.label)}</span><strong>${escapeHtml(slice.valueLabel ?? slice.value)} (${(slice.value * 100 / total).toFixed(1)}%)</strong></li>`).join("");
    const description = chart.description
      ? `<p class="pie-description muted">${escapeHtml(chart.description)}</p>`
      : "";
    return `<article class="pie-card"><h3>${escapeHtml(chart.title)}</h3>${description}<div class="pie" style="background:conic-gradient(${gradients.join(",")})"></div><ul class="legend">${legend}</ul></article>`;
  }).join("");
  return `<div class="chart-grid">${cards}</div>`;
}

export function htmlPieChartSection(title: string, charts: readonly HtmlPieChart[]): HtmlReportSection {
  return { id: "visualizations", title, html: htmlPieCharts(charts) };
}

const LINE_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#dc2626", "#0891b2"];

/** Dependency-free SVG line charts keep generated reports fully offline. */
export function htmlLineCharts(charts: readonly HtmlLineChart[]): string {
  return `<div class="line-chart-grid">${charts.map(renderLineChart).join("")}</div>`;
}

function renderLineChart(chart: HtmlLineChart): string {
  const series = chart.series
    .map((item) => ({
      ...item,
      points: item.points.filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)),
    }))
    .filter((item) => item.points.length > 0);
  if (!series.length) {
    return `<article class="line-chart-card"><h3>${escapeHtml(chart.title)}</h3><p class="muted">无数据。</p></article>`;
  }
  const points = series.flatMap((item) => item.points);
  const minTime = Math.min(...points.map((point) => point.timestamp));
  const maxTime = Math.max(...points.map((point) => point.timestamp));
  const minValue = Math.min(0, ...points.map((point) => point.value));
  const maxValue = Math.max(...points.map((point) => point.value));
  const valueSpan = maxValue - minValue || 1;
  const left = 54;
  const top = 16;
  const width = 680;
  const height = 220;
  const plotWidth = width - left - 18;
  const plotHeight = height - top - 34;
  const x = (timestamp: number) => minTime === maxTime
    ? left + plotWidth / 2
    : left + (timestamp - minTime) / (maxTime - minTime) * plotWidth;
  const y = (value: number) => top + (maxValue - value) / valueSpan * plotHeight;
  const paths = series.map((item, index) => {
    const color = LINE_COLORS[index % LINE_COLORS.length]!;
    const polyline = item.points.map((point) => `${x(point.timestamp).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    const dots = item.points.length <= 20
      ? item.points.map((point) => `<circle cx="${x(point.timestamp).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="2.5" fill="${color}"><title>${escapeHtml(item.label)}: ${escapeHtml(formatChartValue(point.value, chart.unit))}</title></circle>`).join("")
      : "";
    return `<polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join("");
  const legend = series.map((item, index) => `<li><span class="swatch" style="background:${LINE_COLORS[index % LINE_COLORS.length]}"></span><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(formatChartValue(item.points.at(-1)!.value, chart.unit))}</strong></li>`).join("");
  const description = chart.description ? `<p class="muted">${escapeHtml(chart.description)}</p>` : "";
  return `<article class="line-chart-card"><h3>${escapeHtml(chart.title)}</h3>${description}<svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(chart.title)}"><line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" class="chart-axis"/><line x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}" class="chart-axis"/><text x="${left - 8}" y="${top + 5}" text-anchor="end" class="chart-label">${escapeHtml(formatChartValue(maxValue, chart.unit))}</text><text x="${left - 8}" y="${top + plotHeight}" text-anchor="end" class="chart-label">${escapeHtml(formatChartValue(minValue, chart.unit))}</text><text x="${left}" y="${height - 5}" class="chart-label">${escapeHtml(formatChartTime(minTime))}</text><text x="${left + plotWidth}" y="${height - 5}" text-anchor="end" class="chart-label">${escapeHtml(formatChartTime(maxTime))}</text>${paths}</svg><ul class="legend line-chart-legend">${legend}</ul></article>`;
}

function formatChartValue(value: number, unit?: string): string {
  const displayed = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${displayed}${unit ? ` ${unit}` : ""}`;
}

function formatChartTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 横向条形图按本组最大值缩放；领域 renderer 负责提供真实值标签与口径说明。 */
export function htmlBarChart(items: readonly HtmlBarChartItem[]): string {
  const rows = items.filter((item) => Number.isFinite(item.value) && item.value >= 0);
  if (!rows.length) return `<p class="muted">无数据。</p>`;
  const max = Math.max(...rows.map((item) => item.value), 0);
  return `<div class="bar-chart">${rows.map((item) => {
    const width = max > 0 ? Math.max(0, Math.min(100, item.value / max * 100)) : 0;
    const detail = item.detail ? `<span>${escapeHtml(item.detail)}</span>` : "";
    const breakdown = item.breakdown?.items.length
      ? `<details class="bar-chart-breakdown"><summary>${escapeHtml(item.breakdown.title)}</summary>${htmlBarChart(item.breakdown.items)}</details>`
      : "";
    return `<article class="bar-chart-row"><div class="bar-chart-heading"><code>${escapeHtml(item.label)}</code><strong>${escapeHtml(item.valueLabel)}</strong></div><div class="bar-chart-track" aria-label="${escapeHtml(item.label)} 相对本组最大值 ${width.toFixed(1)}%"><div class="bar-chart-fill" style="width:${width.toFixed(1)}%"></div></div><p class="bar-chart-detail">${detail}</p>${breakdown}</article>`;
  }).join("")}</div>`;
}
