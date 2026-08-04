import { escapeHtml } from "./content";
import type { HtmlProgressMetric } from "../model";

export function htmlProgressMetrics(metrics: readonly HtmlProgressMetric[]): string {
  if (!metrics.length) return "";
  // 统一字节尺度才能让纵向排列的 master 直接比较；总量未知时只缩放实色部分，
  // 保留条纹底轨以避免把相对最大值误解为容量已满。
  const scaleMax = Math.max(...metrics.map((metric) => metric.indeterminate ? metric.value : metric.max), 0);
  const cards = metrics.map((metric) => {
    if (metric.indeterminate) {
      const comparisonPercentage = scaleMax > 0
        ? Math.max(0, Math.min(100, metric.value / scaleMax * 100))
        : 0;
      const details = (metric.details ?? [])
        .map((detail) => `<p class="metric-detail">${escapeHtml(detail)}</p>`)
        .join("");
      return `<article class="metric-card metric-card-${metric.tone}"><p class="metric-title">${escapeHtml(metric.title)}</p><div class="metric-values"><strong>${escapeHtml(metric.valueLabel)}</strong><span>${escapeHtml(metric.maxLabel)}</span></div><div class="metric-track metric-track-indeterminate" aria-label="${escapeHtml(metric.title)} 已占用内存；总量未知；相对最大 master 为 ${comparisonPercentage.toFixed(1)}%"><div class="metric-fill" style="width:${comparisonPercentage.toFixed(1)}%"></div></div><p class="metric-status metric-status-${metric.tone}">${escapeHtml(metric.status)}</p>${details}</article>`;
    }
    const ratio = metric.max > 0 ? metric.value / metric.max : 0;
    const percentage = Math.max(0, Math.min(100, ratio * 100));
    const trackPercentage = scaleMax > 0
      ? Math.max(0, Math.min(100, metric.max / scaleMax * 100))
      : 0;
    const percentageLabel = `${(ratio * 100).toFixed(1)}%`;
    const details = (metric.details ?? [])
      .map((detail) => `<p class="metric-detail">${escapeHtml(detail)}</p>`)
      .join("");
    return `<article class="metric-card metric-card-${metric.tone}"><p class="metric-title">${escapeHtml(metric.title)}</p><div class="metric-values"><strong>${escapeHtml(metric.valueLabel)} / ${escapeHtml(metric.maxLabel)}</strong><span>${escapeHtml(percentageLabel)}</span></div><div class="metric-track" style="width:${trackPercentage.toFixed(1)}%" role="progressbar" aria-label="${escapeHtml(metric.title)} 内存使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage.toFixed(1)}"><div class="metric-fill metric-fill-${metric.tone}" style="width:${percentage.toFixed(1)}%"></div></div><p class="metric-status metric-status-${metric.tone}">${escapeHtml(metric.status)}</p>${details}</article>`;
  }).join("");
  const comparisonNote = metrics.length > 1
    ? `<p class="metric-comparison-note">条形按本组 master 的字节数使用统一尺度；总量未知时，最长条仅表示当前已占用内存最多。</p>`
    : "";
  return `${comparisonNote}<div class="metric-grid">${cards}</div>`;
}
