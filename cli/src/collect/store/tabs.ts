import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { escapeHtml } from "../output/html";
import type { DiagnosableStoreKind } from "./config";

export interface StoreReportTab {
  kind: DiagnosableStoreKind;
  html: string;
  /** 聚合层只表达产物是否交付；Evidence 完整度由各领域报告展示。 */
  status: "delivered" | "failed";
}

export function defaultStoreReportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-store-${timestamp}`;
}

export function failedStoreTab(kind: DiagnosableStoreKind, bundlePath?: string): StoreReportTab {
  const detail = bundlePath
    ? `<p>失败 Evidence Bundle：<code>${escapeHtml(bundlePath)}</code></p>`
    : "<p>本轮未生成可交付的诊断报告，请查看终端错误。</p>";
  return {
    kind,
    status: "failed",
    html: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:32px;color:#18212f}code{padding:2px 5px;background:#eef2f7}</style><body><h1>${escapeHtml(kind.toUpperCase())} Store 诊断失败</h1>${detail}</body></html>`,
  };
}

/** 把各 Store 的自包含 HTML 嵌入同一个页签壳；iframe 隔离各领域报告的样式与脚本。 */
export function writeTabbedStoreReport(outputPath: string, tabs: readonly StoreReportTab[]): void {
  const reports = Object.fromEntries(tabs.map((tab) => [
    tab.kind,
    Buffer.from(tab.html, "utf8").toString("base64"),
  ]));
  const buttons = tabs.map((tab, index) => `
    <button type="button" role="tab" data-kind="${tab.kind}" aria-selected="${index === 0}">
      ${escapeHtml(tab.kind.toUpperCase())}
      <span class="status status-${tab.status}">${tab.status === "delivered" ? "已交付" : "失败"}</span>
    </button>`).join("");
  writeFileSync(resolve(outputPath), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>doctor Store 诊断报告</title>
  <style>
    :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#18212f}
    *{box-sizing:border-box}body{margin:0}.header{padding:24px 28px;color:#fff;background:linear-gradient(135deg,#172554,#1d4ed8)}
    .header h1{margin:0 0 5px;font-size:26px}.header p{margin:0;color:#dbeafe}
    [role=tablist]{display:flex;gap:8px;padding:14px 20px;border-bottom:1px solid #dfe5ee;background:#fff}
    [role=tab]{display:flex;align-items:center;gap:8px;border:1px solid #dfe5ee;border-radius:8px;padding:9px 14px;background:#f8fafc;color:#475569;font:inherit;font-weight:700;cursor:pointer}
    [role=tab][aria-selected=true]{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}
    .status{border-radius:999px;padding:1px 7px;font-size:11px}.status-delivered{color:#166534;background:#dcfce7}.status-failed{color:#991b1b;background:#fee2e2}
    iframe{display:block;width:100%;height:calc(100vh - 132px);border:0;background:#fff}
  </style>
</head>
<body>
  <header class="header"><h1>doctor Store 诊断报告</h1><p>一次诊断，多 Store 结果</p></header>
  <nav role="tablist" aria-label="Store 诊断结果">${buttons}</nav>
  <iframe title="Store 诊断详情" sandbox="allow-scripts"></iframe>
  <script>
    const reports=${JSON.stringify(reports)};
    const frame=document.querySelector('iframe');
    const buttons=[...document.querySelectorAll('[role=tab]')];
    function select(button){
      buttons.forEach(item=>item.setAttribute('aria-selected',String(item===button)));
      frame.title=button.textContent.trim()+' 诊断详情';
      const bytes=Uint8Array.from(atob(reports[button.dataset.kind]),char=>char.charCodeAt(0));
      frame.srcdoc=new TextDecoder().decode(bytes);
    }
    buttons.forEach(button=>button.addEventListener('click',()=>select(button)));
    if(buttons[0])select(buttons[0]);
  </script>
</body>
</html>\n`, "utf8");
}
