import { REPORT_SCRIPT } from "./assets/base-script";
import { REPORT_STYLES } from "./assets/base-styles";
import { INSPECTOR_REPORT_SCRIPT } from "./assets/inspector-script";
import { INSPECTOR_REPORT_STYLES } from "./assets/inspector-styles";
import { escapeHtml } from "./components/content";
import type {
  BundleManifest,
  HtmlReportOptions,
  HtmlReportSection,
} from "./model";

interface ReportHeading {
  id: string;
  level: 1 | 2 | 3;
  labelHtml: string;
}

interface SummarySection extends ReportHeading {
  content: string;
  children: SummarySection[];
}

export function buildHtmlReport(manifest: BundleManifest, options: HtmlReportOptions): string {
  const title = options.title ?? "doctor diagnosis report";
  const sections = options.sections ?? [];
  const steps = manifest.steps ?? [];
  const stepRows = steps.map((step) => `
    <tr>
      <td><code>${escapeHtml(step.id)}</code></td>
      <td>${escapeHtml(step.title)}</td>
      <td><span class="status status-${statusClass(step.status)}">${escapeHtml(step.status)}</span></td>
      <td>${step.duration_ms === undefined ? "—" : `${step.duration_ms} ms`}</td>
      <td>${escapeHtml(step.reason ?? "")}</td>
    </tr>`).join("");
  const summary = renderSummary(options.summaryHtml);
  const renderedSections = renderReportSections(sections);
  const renderedInspectionFacts = renderInspectionFacts(manifest.inspection_facts);
  const navigation = renderNavigation(
    summary.headings,
    sections,
    renderedInspectionFacts.length > 0,
  );
  const styles = [
    REPORT_STYLES,
    options.overlay ? INSPECTOR_REPORT_STYLES : "",
    options.assets?.styles ?? "",
  ].filter(Boolean).join("\n");
  const script = [
    REPORT_SCRIPT,
    options.overlay ? INSPECTOR_REPORT_SCRIPT : "",
    options.assets?.script ?? "",
  ].filter(Boolean).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>${escapeHtml(title)}</title>
  <script>
    window.__doctorReportStartedAt = performance.now();
    console.log('[doctor-report] parse:start');
  </script>
  <style>${styles}</style>
</head>
<body>
  <header class="report-header">
    <h1>${escapeHtml(title)}</h1>
    <p>doctor ${escapeHtml(manifest.doctor_version ?? "unknown")} · ${escapeHtml(manifest.started_at ?? "")}</p>
    <p>profile: ${escapeHtml(options.profileName)}</p>
    <p>${escapeHtml(formatTarget(manifest.target))}</p>
  </header>
  <div class="report-layout">
    ${navigation}
    <main class="report-content">
      <section id="report-summary" class="report-summary">${summary.html}</section>
      ${renderedSections}
      ${renderedInspectionFacts}
      <section id="collection-steps">
        <h2>采集步骤</h2>
        <details class="collection-steps-view"><summary><span>查看采集步骤</span><span class="table-summary-meta">${steps.length} 条</span></summary><div class="table-scroll"><table><thead><tr><th>step</th><th>title</th><th>status</th><th>duration</th><th>reason</th></tr></thead><tbody>${stepRows}</tbody></table></div></details>
      </section>
    </main>
  </div>
  ${renderOverlay(options)}
  ${options.overlay ? '<div class="copy-toast" role="status" aria-live="polite" hidden></div>' : ""}
  <script>${script}</script>
</body>
</html>\n`;
}

function sectionId(section: HtmlReportSection, index: number): string {
  return section.id ?? `report-section-${index + 1}`;
}

function renderNavigation(
  summaryHeadings: readonly ReportHeading[],
  sections: readonly HtmlReportSection[],
  hasInspectionFacts: boolean,
): string {
  const items = [
    ...(summaryHeadings.length > 0
      ? summaryHeadings.map((heading) => ({
        href: `#${heading.id}`,
        labelHtml: heading.labelHtml,
        level: heading.level,
      }))
      : [{ href: "#report-summary", labelHtml: "诊断摘要", level: 1 as const }]),
    ...sections.map((section, index) => ({
      href: `#${sectionId(section, index)}`,
      labelHtml: escapeHtml(section.title),
      level: 1 as const,
    })),
    ...(hasInspectionFacts
      ? [{ href: "#inspection-facts", labelHtml: "Inspect Facts", level: 1 as const }]
      : []),
    { href: "#collection-steps", labelHtml: "采集步骤", level: 1 as const },
  ];
  const links = items
    .map((item) => `<a class="nav-level-${item.level}" href="${escapeHtml(item.href)}">${item.labelHtml}</a>`)
    .join("");
  return `<aside class="sidebar"><p class="sidebar-title">报告目录</p><nav aria-label="报告目录">${links}</nav></aside>`;
}

function renderReportSections(sections: readonly HtmlReportSection[]): string {
  return sections
    .map((section, index) => `<section id="${escapeHtml(sectionId(section, index))}"><h2>${escapeHtml(section.title)}</h2>${section.html}</section>`)
    .join("");
}

function renderInspectionFacts(facts: Record<string, unknown> | undefined): string {
  const entries = Object.entries(facts ?? {});
  if (!entries.length) return "";
  const cards = entries.map(([name, value]) => {
    const factStatus = typeof value === "object" && value !== null && "status" in value
      ? String((value as { status?: unknown }).status ?? "collected")
      : "collected";
    const serialized = JSON.stringify(value, null, 2) ?? String(value);
    return `<details class="inspection-fact"><summary><code>${escapeHtml(name)}</code><span class="status status-${statusClass(factStatus)}">${escapeHtml(factStatus)}</span></summary><pre>${escapeHtml(serialized)}</pre></details>`;
  }).join("");
  return `<section id="inspection-facts"><h2>Inspect Facts</h2><p class="muted">采集行动前取得的结构化环境事实；敏感信息应在进入 manifest 前完成脱敏。</p><div class="inspection-facts">${cards}</div></section>`;
}

function renderSummary(summaryHtml: string): { html: string; headings: ReportHeading[] } {
  const headingPattern = /<h([1-3])>([\s\S]*?)<\/h\1>/g;
  const roots: SummarySection[] = [];
  const headings: ReportHeading[] = [];
  const stack: SummarySection[] = [];
  let preamble = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(summaryHtml)) !== null) {
    const preceding = summaryHtml.slice(cursor, match.index);
    if (stack.length > 0) stack[stack.length - 1]!.content += preceding;
    else preamble += preceding;

    const level = Number(match[1]) as 1 | 2 | 3;
    const section: SummarySection = {
      id: `report-heading-${headings.length + 1}`,
      level,
      labelHtml: match[2]!.replace(/<[^>]*>/g, ""),
      content: "",
      children: [],
    };
    headings.push(section);
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    if (stack.length > 0) stack[stack.length - 1]!.children.push(section);
    else roots.push(section);
    stack.push(section);
    cursor = headingPattern.lastIndex;
  }

  const trailing = summaryHtml.slice(cursor);
  if (stack.length > 0) stack[stack.length - 1]!.content += trailing;
  else preamble += trailing;
  if (headings.length === 0) return { html: summaryHtml, headings };
  return { html: preamble + roots.map(renderSummarySection).join(""), headings };
}

function renderSummarySection(section: SummarySection): string {
  const heading = `<h${section.level} id="${section.id}">${section.labelHtml}</h${section.level}>`;
  const body = section.content + section.children.map(renderSummarySection).join("");
  if (section.level === 1) return heading + body;
  return `<details class="report-subsection section-level-${section.level}" open><summary>${heading}<span class="section-chevron" aria-hidden="true"></span></summary><div class="report-subsection-body">${body}</div></details>`;
}

function renderOverlay(options: HtmlReportOptions): string {
  const overlay = options.overlay;
  if (!overlay) return "";
  return `<aside class="report-inspector" role="dialog" aria-modal="false" aria-label="${escapeHtml(overlay.ariaLabel)}" hidden>
      <div class="report-inspector-toolbar"><strong>${escapeHtml(overlay.title)}</strong><button type="button" class="report-inspector-close" aria-label="关闭${escapeHtml(overlay.title)}">×</button></div>
      <div class="report-inspector-body">${overlay.html}</div>
    </aside>`;
}

function statusClass(status: string): string {
  if (status === "ok" || status === "collected") return "ok";
  if (status === "failed") return "failed";
  if (status === "unnecessary") return "unnecessary";
  return "other";
}

function formatTarget(target: Record<string, unknown> | undefined): string {
  if (!target) return "";
  return Object.entries(target).map(([key, value]) => `${key}=${String(value)}`).join(" · ");
}
