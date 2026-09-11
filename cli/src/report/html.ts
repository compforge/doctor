import { escapeHtml } from "../collect/output/report/components/content";
import { REPORT_ARCHIVE_SCRIPT, ReportArchive } from "./archive";
import type { RenderContext } from "./context";
import type { Report } from "./model";

/** One reading shell; navigation identity comes from Report, never from directory names or HTML bytes. */
export function renderReportHtml(report: Report, context: RenderContext): string {
  const archive = new ReportArchive();
  const sections = report.sections.map(section => ({ ...section, pages: section.pages.map(page => {
    const { source, ...metadata } = page;
    return { ...metadata, ...(source ? archive.addPage(context.read(context.artifact(source.artifactId), source.file)) : {}) };
  }) }));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(report.title)}</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18212f;background:#fff;color-scheme:light}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;overflow:hidden}
header{display:flex;gap:14px;align-items:center;padding:10px 16px;background:#f8fafc;border-bottom:1px solid #dfe5ee}
h1{font-size:17px;margin:0;white-space:nowrap}#scope{font-size:12px;color:#64748b}
nav{display:flex;gap:6px;padding:7px 12px;overflow-x:auto;border-bottom:1px solid #dfe5ee}
button,select{font:inherit;font-size:13px;border:1px solid #dfe5ee;border-radius:6px;background:#fff;padding:5px 9px;color:inherit}
button{cursor:pointer;white-space:nowrap}button[aria-selected=true]{border-color:#2563eb;color:#1d4ed8;background:#eff6ff}
#context{display:flex;align-items:center;gap:16px;padding:6px 16px;border-bottom:1px solid #dfe5ee;font-size:12px;min-height:34px}
label{display:flex;align-items:center;gap:6px;min-width:0}select{max-width:min(55vw,650px)}#identity{overflow-wrap:anywhere}
#status{font-size:12px;color:#64748b}#message{padding:20px;white-space:pre-wrap;overflow-wrap:anywhere}
iframe{display:block;flex:1;min-height:0;width:100%;border:0;background:#fff}[hidden]{display:none!important}
@media(max-width:700px){header,#context{flex-wrap:wrap;gap:6px}select{max-width:75vw}}
</style></head><body>
<header><h1>${escapeHtml(report.title)}</h1><span id="scope"></span></header>
<nav id="commands" role="tablist" aria-label="诊断命令"></nav>
<div id="context"><label id="subject-label">请求 <select id="subject" aria-label="请求"></select></label><span id="identity"></span>
<label id="page-label">结果 <select id="page" aria-label="结果"></select></label><span id="status" role="status"></span></div>
<div id="message" role="status" hidden></div><iframe title="诊断详情" sandbox="allow-scripts allow-downloads"></iframe>
${archive.embedIndex({ version: 2, sections })}
<script>${REPORT_ARCHIVE_SCRIPT}
${REPORT_NAVIGATION_SCRIPT}
</script></body></html>`;
}

// Kept separate from the encoder so browser navigation can be exercised against small synthetic reports.
export const REPORT_NAVIGATION_SCRIPT = String.raw`
const sections=reportIndex.sections;
const commands=document.getElementById('commands'),subjects=document.getElementById('subject'),pages=document.getElementById('page');
const identity=document.getElementById('identity'),scope=document.getElementById('scope'),status=document.getElementById('status'),message=document.getElementById('message');
let frame=document.querySelector('iframe');
const labels={ok:'采集完成',partial:'采集部分完成',failed:'采集失败',cancelled:'已取消'};
const allSubjects=[...new Map(sections.flatMap(section=>section.pages.flatMap(page=>page.subject?[[page.subject.key,page.subject]]:[]))).values()];
let sectionIndex=0,subjectKey=allSubjects[0]?.key,selection=0;
const selectedPages=new Map();
function option(value,label){const item=document.createElement('option');item.value=value;item.textContent=label;return item;}
for(const subject of allSubjects)subjects.append(option(subject.key,subject.label));
function releaseFrame(){
  // Replacing the browsing context releases domain state immediately; stale iframe loads cannot win a later selection.
  const next=frame.cloneNode(false);next.removeAttribute('srcdoc');next.removeAttribute('src');frame.replaceWith(next);frame=next;
}
async function loadPage(page){
  const current=++selection;releaseFrame();message.hidden=true;
  status.textContent=page?(labels[page.status]||page.status)+(page.renderError?' · 报告生成失败':''):'';
  frame.hidden=!page?.entry;
  if(!page?.entry){message.hidden=false;message.textContent=page?.renderError?'报告生成失败：'+page.renderError:page?.reason||'当前请求没有这项诊断结果';return;}
  frame.title=page.title+' 诊断详情';message.hidden=false;message.textContent='正在加载…';
  await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
  if(current!==selection)return;
  try{frame.srcdoc=fflate.strFromU8(readReportEntry(page.entry));message.hidden=!page.reason;message.textContent=page.reason||'';}
  catch(error){message.hidden=false;message.textContent='页面加载失败：'+error.message;}
}
function selectPage(available){
  const key=JSON.stringify([sections[sectionIndex].id,subjectKey]);
  const selected=available.find(page=>page.id===selectedPages.get(key))||available[0];
  pages.replaceChildren(...available.map(page=>option(page.id,page.title+' · '+(labels[page.status]||page.status))));
  document.getElementById('page-label').hidden=available.length<2;
  if(selected)pages.value=selected.id;
  pages.onchange=()=>{selectedPages.set(key,pages.value);loadPage(available.find(page=>page.id===pages.value));};
  loadPage(selected);
}
function showSection(){
  const section=sections[sectionIndex];if(!section)return;
  [...commands.children].forEach((button,index)=>button.setAttribute('aria-selected',String(index===sectionIndex)));
  const scoped=section.pages.some(page=>page.subject);
  document.getElementById('subject-label').hidden=!scoped||allSubjects.length<2;
  subjects.value=subjectKey||'';
  identity.textContent=scoped&&allSubjects.length===1?allSubjects[0].label:'';
  scope.textContent=section.scope||'';
  // Shared evidence leaves the current request selection intact; missing evidence never switches to another request.
  selectPage(scoped?section.pages.filter(page=>page.subject?.key===subjectKey):section.pages);
}
for(const [index,section] of sections.entries()){
  const button=document.createElement('button');button.type='button';button.role='tab';button.dataset.command=section.id;
  button.textContent=section.title;button.title=labels[section.status]||section.status;
  button.onclick=()=>{sectionIndex=index;showSection();};commands.append(button);
}
commands.hidden=sections.length<2;
subjects.onchange=()=>{subjectKey=subjects.value;showSection();};
showSection();
`;
