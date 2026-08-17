import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { escapeHtml } from "./html";

export interface ReportTab {
  key: string;
  label: string;
  html: string;
  status: "delivered" | "failed";
}

export interface TabbedReportInput {
  title: string;
  description: string;
  ariaLabel: string;
  tabs: readonly ReportTab[];
}

/** Embed self-contained child reports in an iframe so their styles and scripts stay isolated. */
export function renderTabbedReport(input: TabbedReportInput): string {
  const reports = Object.fromEntries(input.tabs.map((tab) => [
    tab.key,
    Buffer.from(tab.html, "utf8").toString("base64"),
  ]));
  const buttons = input.tabs.map((tab, index) => `
    <button type="button" role="tab" data-key="${escapeHtml(tab.key)}" data-kind="${escapeHtml(tab.key)}" aria-selected="${index === 0}">
      ${escapeHtml(tab.label)}
      <span class="status status-${tab.status}">${tab.status === "delivered" ? "已交付" : "失败"}</span>
    </button>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#18212f}
    *{box-sizing:border-box}body{margin:0}.header{padding:24px 28px;color:#fff;background:linear-gradient(135deg,#172554,#1d4ed8)}
    .header h1{margin:0 0 5px;font-size:26px}.header p{margin:0;color:#dbeafe}
    [role=tablist]{display:flex;gap:8px;padding:14px 20px;border-bottom:1px solid #dfe5ee;background:#fff;overflow-x:auto}
    [role=tab]{display:flex;align-items:center;gap:8px;border:1px solid #dfe5ee;border-radius:8px;padding:9px 14px;background:#f8fafc;color:#475569;font:inherit;font-weight:700;cursor:pointer;white-space:nowrap}
    [role=tab][aria-selected=true]{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}
    .status{border-radius:999px;padding:1px 7px;font-size:11px}.status-delivered{color:#166534;background:#dcfce7}.status-failed{color:#991b1b;background:#fee2e2}
    iframe{display:block;width:100%;height:calc(100vh - 132px);border:0;background:#fff}
  </style>
</head>
<body>
  <header class="header"><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.description)}</p></header>
  <nav role="tablist" aria-label="${escapeHtml(input.ariaLabel)}">${buttons}</nav>
  <iframe title="诊断详情" sandbox="allow-scripts"></iframe>
  <script>
    const reports=${JSON.stringify(reports)};
    const frame=document.querySelector('iframe');
    const buttons=[...document.querySelectorAll('[role=tab]')];
    function select(button){
      buttons.forEach(item=>item.setAttribute('aria-selected',String(item===button)));
      frame.title=button.textContent.trim()+' 诊断详情';
      const bytes=Uint8Array.from(atob(reports[button.dataset.key]),char=>char.charCodeAt(0));
      frame.srcdoc=new TextDecoder().decode(bytes);
    }
    buttons.forEach(button=>button.addEventListener('click',()=>select(button)));
    if(buttons[0])select(buttons[0]);
  </script>
</body>
</html>
`;
}

export function writeTabbedReport(outputPath: string, input: TabbedReportInput): void {
  writeFileSync(resolve(outputPath), renderTabbedReport(input), "utf8");
}

export function failedReportHtml(title: string, detail: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px;color:#18212f}code{padding:2px 5px;background:#eef2f7}</style><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
}
