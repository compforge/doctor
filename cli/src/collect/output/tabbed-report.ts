import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { escapeHtml } from "./html";
import { ReportArchive, normalizeReportTabs, REPORT_ARCHIVE_SCRIPT, type ReportNavigation } from "./report-archive";

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
  tabs: readonly ReportTab[];
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

function tabButton(tab: Pick<ReportNavigation, "key" | "label" | "status">, index: number): string {
  return `
    <button type="button" role="tab" data-key="${escapeHtml(tab.key)}" data-kind="${escapeHtml(tab.key)}" aria-selected="${index === 0}">
      <span class="tab-label">${escapeHtml(tab.label)}</span>
      <span class="status status-${tab.status}">${tab.status === "delivered" ? "已交付" : "失败"}</span>
    </button>`;
}

/** Keep grouped navigation in one shell; only leaf reports enter the isolated iframe. */
export function renderTabbedReport(input: TabbedReportInput): string {
  const archive = new ReportArchive();
  const navigation = (tab: ReportTab): ReportNavigation => ({
    key: tab.key, label: tab.label, status: tab.status,
    ...(isTabGroup(tab) ? { tabs: normalizeReportTabs(tab.tabs.map(navigation)) } : archive.add(tab.html)),
  });
  const tabs = normalizeReportTabs(input.tabs.map(navigation));
  const buttons = tabs.map(tabButton).join("");
  const singleTab = tabs.length === 1 ? tabs[0] : undefined;
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
  <div id="report-status" role="status"></div>
  <iframe title="诊断详情" sandbox="allow-scripts allow-downloads"></iframe>
  ${archive.embed(tabs)}
  <script>
    ${REPORT_ARCHIVE_SCRIPT}
    const frame=document.querySelector('iframe');
    const primary=[...document.querySelectorAll('#primary-tabs [role=tab]')];
    const secondary=document.querySelector('#secondary-tabs');
    const status=document.querySelector('#report-status');
    let selection=0;
    async function loadReport(tab){
      const current=++selection;
      frame.removeAttribute('srcdoc');frame.src='about:blank';frame.title=tab.label+' 诊断详情';
      status.textContent='正在加载 '+tab.label+'…';
      // Give navigation a paint before inflating the selected entry; stale clicks cannot replace it.
      await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
      if(current!==selection)return;
      try{const html=fflate.strFromU8(readReportEntry(tab.entry));if(current!==selection)return;frame.srcdoc=html;status.textContent='';}
      catch(error){if(current===selection)status.textContent='加载失败：'+error.message;}
    }
    function childButton(tab){
      const button=document.createElement('button');button.type='button';button.role='tab';button.dataset.key=tab.key;button.dataset.kind=tab.key;
      const label=document.createElement('span');label.className='tab-label';label.textContent=tab.label;
      const badge=document.createElement('span');badge.className='status status-'+tab.status;badge.textContent=tab.status==='delivered'?'已交付':'失败';
      button.append(label,badge);return button;
    }
    function selectTab(button,tab,depth){
      [...button.parentElement.children].forEach(item=>item.setAttribute('aria-selected',String(item===button)));
      document.querySelectorAll('[data-report-depth]').forEach(nav=>{if(Number(nav.dataset.reportDepth)>depth)nav.remove();});
      secondary.hidden=true;
      if(tab.tabs&&tab.tabs.length){
        const nav=document.createElement('nav');nav.role='tablist';nav.className='secondary';nav.dataset.reportDepth=String(depth+1);nav.setAttribute('aria-label',tab.label+' 子结果');
        for(const child of tab.tabs){const b=childButton(child);b.onclick=()=>selectTab(b,child,depth+1);nav.appendChild(b);}
        frame.before(nav);selectTab(nav.firstElementChild,tab.tabs[0],depth+1);
      }else if(tab.entry){loadReport(tab);}
    }
    primary.forEach((button,index)=>button.onclick=()=>selectTab(button,reportIndex.tabs[index],0));
    if(primary[0])selectTab(primary[0],reportIndex.tabs[0],0);
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
