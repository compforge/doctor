import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { escapeHtml, serializeInlineJson } from "./html";

interface ReportTabBase {
  key: string;
  label: string;
  status: "delivered" | "failed";
}

export interface ReportLeafTab extends ReportTabBase {
  html: string;
  tabs?: never;
}

export interface ReportTabGroup extends ReportTabBase {
  tabs: readonly ReportLeafTab[];
  html?: never;
}

export type ReportTab = ReportLeafTab | ReportTabGroup;

export interface TabbedReportInput {
  title: string;
  description: string;
  ariaLabel: string;
  tabs: readonly ReportTab[];
}

function isTabGroup(tab: ReportTab): tab is ReportTabGroup {
  return Array.isArray(tab.tabs);
}

function tabButton(tab: ReportTab, index: number): string {
  return `
    <button type="button" role="tab" data-key="${escapeHtml(tab.key)}" data-kind="${escapeHtml(tab.key)}" aria-selected="${index === 0}">
      <span class="tab-label">${escapeHtml(tab.label)}</span>
      <span class="status status-${tab.status}">${tab.status === "delivered" ? "已交付" : "失败"}</span>
    </button>`;
}

/** Keep grouped navigation in one shell; only leaf reports enter the isolated iframe. */
export function renderTabbedReport(input: TabbedReportInput): string {
  const leafTabs = input.tabs.flatMap((tab) => isTabGroup(tab) ? tab.tabs : [tab]);
  const reports = Object.fromEntries(leafTabs.map((tab) => [
    tab.key,
    Buffer.from(tab.html, "utf8").toString("base64"),
  ]));
  const childTabs = Object.fromEntries(input.tabs
    .filter(isTabGroup)
    .map((tab) => [tab.key, tab.tabs.map(({ key, label, status }) => ({ key, label, status }))]));
  const buttons = input.tabs.map(tabButton).join("");
  const singleTab = input.tabs.length === 1 ? input.tabs[0] : undefined;
  const context = singleTab
    ? `<div class="context"><span class="tab-label">${escapeHtml(singleTab.label)}</span><span class="status status-${singleTab.status}">${singleTab.status === "delivered" ? "已交付" : "失败"}</span></div>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#18212f}
    *{box-sizing:border-box}html,body{height:100%}body{margin:0;display:flex;flex-direction:column;overflow:hidden}
    .header{display:flex;align-items:center;gap:14px;min-height:48px;padding:8px 16px;border-bottom:1px solid #dfe5ee;background:#f8fafc}
    .heading{display:flex;align-items:baseline;gap:10px;min-width:0}.header h1{margin:0;font-size:16px;white-space:nowrap}.header p{margin:0;color:#64748b;font-size:12px;white-space:nowrap}
    .context{display:flex;align-items:center;gap:7px;min-width:0;margin-left:auto;padding:4px 8px;border:1px solid #dbe5ef;border-radius:6px;background:#fff;color:#334155;font-size:12px;font-weight:650}
    .tab-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    [role=tablist]{display:flex;gap:6px;min-height:39px;padding:6px 12px;border-bottom:1px solid #dfe5ee;background:#fff;overflow-x:auto}
    [role=tablist].secondary{padding-left:22px;background:#f8fafc}[role=tablist][hidden]{display:none}
    [role=tab]{display:flex;align-items:center;gap:7px;max-width:min(72vw,620px);border:1px solid #dfe5ee;border-radius:6px;padding:5px 10px;background:#fff;color:#475569;font:inherit;font-size:12px;font-weight:650;cursor:pointer;white-space:nowrap}
    [role=tab][aria-selected=true]{border-color:#2563eb;background:#eff6ff;color:#1d4ed8}
    .status{border-radius:999px;padding:1px 7px;font-size:11px}.status-delivered{color:#166534;background:#dcfce7}.status-failed{color:#991b1b;background:#fee2e2}
    iframe{display:block;flex:1;min-height:0;width:100%;border:0;background:#fff}
    @media(max-width:720px){.header{align-items:flex-start}.heading{display:block}.header p{margin-top:1px}.context{max-width:42vw}}
  </style>
</head>
<body>
  <header class="header"><div class="heading"><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.description)}</p></div>${context}</header>
  <nav id="primary-tabs" role="tablist" aria-label="${escapeHtml(input.ariaLabel)}"${singleTab ? " hidden" : ""}>${buttons}</nav>
  <nav id="secondary-tabs" class="secondary" role="tablist" aria-label="子结果" hidden></nav>
  <iframe title="诊断详情" sandbox="allow-scripts"></iframe>
  <script>
    const reports=${serializeInlineJson(reports)};
    const childTabs=${serializeInlineJson(childTabs)};
    const frame=document.querySelector('iframe');
    const primary=[...document.querySelectorAll('#primary-tabs [role=tab]')];
    const secondary=document.querySelector('#secondary-tabs');
    function labelOf(button){return button.querySelector('.tab-label').textContent.trim();}
    function loadReport(key,label){
      frame.title=label+' 诊断详情';
      const bytes=Uint8Array.from(atob(reports[key]),char=>char.charCodeAt(0));
      frame.srcdoc=new TextDecoder().decode(bytes);
    }
    function selectSecondary(button){
      [...secondary.querySelectorAll('[role=tab]')].forEach(item=>item.setAttribute('aria-selected',String(item===button)));
      loadReport(button.dataset.key,labelOf(button));
    }
    function childButton(tab,index){
      const button=document.createElement('button');button.type='button';button.role='tab';button.dataset.key=tab.key;button.dataset.kind=tab.key;button.setAttribute('aria-selected',String(index===0));
      const label=document.createElement('span');label.className='tab-label';label.textContent=tab.label;
      const status=document.createElement('span');status.className='status status-'+tab.status;status.textContent=tab.status==='delivered'?'已交付':'失败';
      button.append(label,status);button.addEventListener('click',()=>selectSecondary(button));return button;
    }
    function selectPrimary(button){
      primary.forEach(item=>item.setAttribute('aria-selected',String(item===button)));
      const children=childTabs[button.dataset.key]||[];secondary.replaceChildren();
      if(children.length){children.forEach((tab,index)=>secondary.appendChild(childButton(tab,index)));secondary.hidden=false;secondary.setAttribute('aria-label',labelOf(button)+' Trace 结果');selectSecondary(secondary.firstElementChild);}
      else{secondary.hidden=true;loadReport(button.dataset.key,labelOf(button));}
    }
    primary.forEach(button=>button.addEventListener('click',()=>selectPrimary(button)));
    if(primary[0])selectPrimary(primary[0]);
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
