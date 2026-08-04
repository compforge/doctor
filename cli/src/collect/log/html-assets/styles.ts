export const LOG_REPORT_STYLES = `
.log-viewer { --log-border:#d7dee8; --log-panel:#f8fafc; color:#18212f; }
.log-toolbar { position:sticky; top:0; z-index:4; display:grid; grid-template-columns:minmax(260px,2fr) repeat(2,minmax(150px,1fr)); gap:10px; padding:14px; border:1px solid var(--log-border); border-radius:12px; background:rgba(255,255,255,.96); box-shadow:0 8px 24px rgba(15,23,42,.08); backdrop-filter:blur(8px); }
.log-toolbar label { display:flex; flex-direction:column; gap:4px; color:#526173; font-size:12px; }
.log-toolbar input,.log-toolbar select { min-width:0; border:1px solid #cbd5e1; border-radius:7px; padding:8px 10px; background:#fff; color:#172033; font:inherit; }
.log-search-field { grid-column:span 1; }
.log-time-filter { display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end; margin-top:10px; }
.log-time-filter button,.log-toolbar button,.log-controls button,.log-context-button,.log-quick-filter { border:1px solid #cbd5e1; border-radius:7px; padding:7px 10px; background:#fff; color:#334155; cursor:pointer; }
.log-time-filter button:hover,.log-controls button:hover,.log-context-button:hover,.log-quick-filter:hover { border-color:#64748b; background:#f8fafc; }
.log-time-filter button:disabled,.log-controls button:disabled { opacity:.45; cursor:default; }
.log-quick-filters { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
.log-quick-filter { padding:4px 9px; font-size:12px; }
.log-histogram { display:flex; align-items:end; gap:2px; height:92px; margin:14px 0 8px; padding:8px 8px 0; border:1px solid var(--log-border); border-radius:10px; background:linear-gradient(#f8fafc,#fff); }
.log-histogram-bar { flex:1 1 0; min-width:2px; height:var(--bar-height); border:0; border-radius:3px 3px 0 0; background:#60a5fa; cursor:pointer; opacity:.85; }
.log-histogram-bar:hover { background:#2563eb; opacity:1; }
.log-histogram-empty { margin:auto; color:#64748b; font-size:13px; }
.log-errors { margin:10px 0; border:1px solid #fecaca; border-radius:8px; background:#fff7f7; }
.log-errors summary { cursor:pointer; padding:9px 12px; color:#991b1b; }
.log-errors pre { margin:0; padding:12px; border-top:1px solid #fecaca; white-space:pre-wrap; overflow-wrap:anywhere; }
.log-result-bar,.log-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:10px 0; }
.log-result-meta,.log-page-info { color:#526173; font-size:13px; }
.log-result-bar .log-result-meta { margin-right:auto; }
.log-list { border:1px solid var(--log-border); border-radius:10px; overflow:hidden; background:#fff; }
.log-row { border-left:4px solid var(--source-color,#94a3b8); border-bottom:1px solid #e8edf3; padding:9px 12px; }
.log-row:last-child { border-bottom:0; }
.log-row.is-active-match { background:#eff6ff; box-shadow:inset 0 0 0 1px #93c5fd; }
.log-row-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:5px; color:#64748b; font-size:12px; }
.log-source { border-radius:999px; padding:2px 7px; background:#eef2f7; color:#334155; font-weight:600; }
.log-instance-previous { color:#9a3412; }
.log-message { margin:0; padding:0; border:0; background:transparent; color:#111827; white-space:pre-wrap; overflow-wrap:anywhere; font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }
.log-message mark { border-radius:2px; padding:0 1px; background:#fde047; color:#111827; }
.log-context-button { margin-left:auto; padding:2px 7px; font-size:11px; }
.log-context { margin-top:8px; border-top:1px dashed #cbd5e1; padding-top:6px; }
.log-context-line { display:grid; grid-template-columns:170px 1fr; gap:8px; padding:3px 0; color:#64748b; font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; }
.log-context-line code { white-space:pre-wrap; overflow-wrap:anywhere; color:#475569; }
.log-empty { padding:32px; text-align:center; color:#64748b; }
.log-controls { justify-content:flex-end; }
@media (max-width:900px) {
  .log-toolbar { position:static; grid-template-columns:1fr; }
  .log-time-filter { grid-template-columns:1fr; }
  .log-context-line { grid-template-columns:1fr; }
}
`;
