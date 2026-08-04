/** Optional HTTP exchange inspector styles; not embedded in ordinary reports. */
export const INSPECTOR_REPORT_STYLES = `
.report-inspector { position:fixed; z-index:1000; top:6vh; left:max(24px,calc(50vw - 600px)); width:min(1200px,calc(100vw - 48px)); max-width:calc(100vw - max(48px,calc(100vw - 1200px))); height:min(72vh,720px); min-width:min(620px,calc(100vw - 48px)); min-height:min(320px,88vh); max-height:88vh; overflow:auto; resize:both; border:1px solid #b8c5d8; border-radius:12px; background:var(--panel); box-shadow:0 20px 60px rgba(15,23,42,.28); }
.report-inspector[hidden] { display:none; }
.report-inspector-toolbar { position:sticky; z-index:3; top:0; display:flex; justify-content:space-between; align-items:center; min-height:38px; padding:5px 10px; border-bottom:1px solid var(--line); background:#f8fafc; cursor:grab; user-select:none; }
.report-inspector-toolbar.is-dragging { cursor:grabbing; }
.report-inspector-toolbar strong { font-size:12px; letter-spacing:.04em; text-transform:uppercase; }
.report-inspector-close { border:0; padding:3px 9px; color:var(--muted); background:transparent; font-size:18px; line-height:1; cursor:pointer; }
.report-inspector-body { padding:0 14px 14px; }
.inspector-placeholder { color:var(--muted); }
.inspector-placeholder p { margin:6px 0 0; }
.http-exchange-detail > header { display:flex; flex-wrap:wrap; gap:5px 12px; align-items:center; padding:10px 0; border-bottom:1px solid var(--line); }
.http-exchange-detail > header strong { font-size:15px; }
.http-exchange-detail > header span { color:var(--muted); font-size:12px; }
.exchange-outcome { border-radius:999px; padding:2px 8px; font-weight:700; }
.exchange-outcome-ok { color:#166534 !important; background:#dcfce7; }
.exchange-outcome-warning { color:#a16207 !important; background:#fef3c7; }
.exchange-outcome-failed { color:#991b1b !important; background:#fee2e2; }
.exchange-missing-response,.exchange-stream-warning { border-left:3px solid #ef4444; margin:10px 0; padding:9px 11px; color:#991b1b; background:#fff7f7; }
.exchange-start-line { margin:0; overflow-wrap:anywhere; }
.exchange-header-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:6px 18px; margin:10px 0; }
.exchange-header-list > div { display:grid; grid-template-columns:minmax(100px,28%) 1fr; gap:8px; overflow-wrap:anywhere; }
.exchange-timing { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 10px; align-items:start; max-width:760px; }
.exchange-timing span { color:var(--muted); font-size:12px; }
.exchange-timing code { overflow-wrap:anywhere; }
.exchange-body-note { margin:8px 0; color:var(--muted); font-size:12px; }
.exchange-overview { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.exchange-overview-card { min-width:0; padding:12px; border:1px solid var(--line); border-radius:8px; background:#fbfcfe; }
.exchange-overview-card h3 { margin:0 0 7px; font-size:13px; }
.exchange-overview-card p { margin:4px 0; overflow-wrap:anywhere; }
.exchange-tab-list { display:flex; gap:2px; overflow-x:auto; border-bottom:1px solid var(--line); }
.exchange-tab-list button { flex:0 0 auto; border:0; border-bottom:2px solid transparent; border-radius:0; padding:8px 13px 6px; color:var(--muted); background:transparent; font-weight:600; }
.exchange-tab-list button:hover { color:var(--accent); background:#eff6ff; }
.exchange-tab-list button[aria-selected="true"] { border-bottom-color:var(--accent); color:var(--accent); }
.exchange-tab-group-secondary { margin-top:8px; }
.exchange-tab-group-secondary > .exchange-tab-list button { padding-top:5px; padding-bottom:4px; font-size:12px; }
.exchange-tab-panel { padding:12px 2px 2px; }
.exchange-tab-panel[hidden] { display:none; }
.exchange-tab-panel > :first-child { margin-top:0; }
.exchange-json-preview { color:#dbeafe; }
.exchange-sse-toolbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px; }
.exchange-sse-search { min-width:260px; border:1px solid var(--line); border-radius:6px; padding:6px 9px; color:var(--ink); background:#fff; font:inherit; }
.exchange-sse-events { display:grid; gap:7px; }
.exchange-sse-event { margin:0; }
.exchange-sse-event[hidden] { display:none; }
.exchange-sse-event > summary { align-items:center; gap:10px; padding:8px 10px; color:var(--ink); }
.exchange-sse-event-index { min-width:32px; color:var(--muted); font-variant-numeric:tabular-nums; }
.exchange-sse-event-type { min-width:90px; font-weight:700; }
.exchange-sse-event-summary { flex:1; overflow:hidden; color:var(--muted); text-overflow:ellipsis; white-space:nowrap; }
.exchange-sse-event-bytes { color:var(--muted); font-size:12px; }
.exchange-sse-event-content { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; padding:0 10px 10px; }
.exchange-sse-event-content h4 { margin:8px 0 4px; }
.exchange-sse-event-content pre { max-height:260px; margin:0; }
.exchange-sse-trailing { border-color:#fecaca; background:#fff7f7; }
.exchange-copy-block { position:relative; }
.exchange-copy-block pre { min-height:54px; padding-top:48px; }
.copy-text-button { position:absolute; z-index:1; top:8px; right:8px; margin:0; }
[data-inspector-id] { cursor:pointer; }
[data-inspector-id].is-selected { filter:drop-shadow(0 0 4px rgba(37,99,235,.65)); }
.copy-toast { position:fixed; z-index:1001; right:20px; bottom:20px; border-radius:8px; padding:9px 13px; color:#fff; background:#166534; box-shadow:0 8px 24px rgba(15,23,42,.18); }
.copy-toast[hidden] { display:none; }
@media (max-width:1100px) {
  .report-inspector { top:4vh; left:12px; width:calc(100vw - 24px); max-width:calc(100vw - 24px); height:78vh; min-width:0; min-height:240px; max-height:92vh; resize:vertical; }
  .exchange-overview,.exchange-sse-event-content { grid-template-columns:1fr; }
}
@media print {
  .report-inspector { display:none; }
}
`;
