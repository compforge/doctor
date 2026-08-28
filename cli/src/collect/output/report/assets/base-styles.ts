/** Styles shared by every generated single-file report. */
export const REPORT_STYLES = `
:root { color-scheme:light; --bg:#f5f7fb; --panel:#fff; --ink:#18212f; --muted:#667085; --line:#dfe5ee; --accent:#2563eb; }
* { box-sizing:border-box; }
body { margin:0; color:var(--ink); background:var(--bg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.report-header { color:#fff; background:linear-gradient(135deg,#172554,#1d4ed8); padding:32px max(24px,calc((100vw - 1440px)/2)); }
.report-header h1 { margin:0 0 8px; font-size:28px; }
.report-header p { margin:3px 0; color:#dbeafe; }
.report-layout { display:grid; grid-template-columns:260px minmax(0,1fr); gap:24px; max-width:1440px; margin:24px auto 56px; padding:0 24px; align-items:start; }
.sidebar { position:sticky; top:24px; padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:0 3px 16px rgba(15,23,42,.05); }
.sidebar-title { margin:0 0 10px; color:var(--muted); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.sidebar nav { display:grid; gap:4px; }
.sidebar a { display:block; border-radius:7px; padding:7px 10px; color:var(--ink); text-decoration:none; }
.sidebar a:hover { color:var(--accent); background:#eff6ff; }
.sidebar .nav-level-1 { font-weight:700; }
.sidebar .nav-level-2 { padding-left:24px; font-size:13px; }
.sidebar .nav-level-3 { padding-left:40px; color:var(--muted); font-size:12px; }
.report-content { min-width:0; }
section { margin:18px 0; padding:24px; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:0 3px 16px rgba(15,23,42,.05); }
.report-content > section,.report-subsection { content-visibility:auto; contain-intrinsic-size:auto 500px; }
.report-subsection:has(.metric-grid) { content-visibility:visible; contain:none; }
.report-content > section:first-child { margin-top:0; }
section[id] { scroll-margin-top:24px; }
h1,h2,h3 { line-height:1.3; }
h2 { margin-top:30px; padding-bottom:8px; border-bottom:1px solid var(--line); }
section > h2:first-child { margin-top:0; }
code { padding:2px 5px; border-radius:5px; background:#eef2f7; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
pre { overflow:auto; margin:12px 0 0; padding:16px; border-radius:8px; color:#dbeafe; background:#111827; white-space:pre-wrap; word-break:break-word; }
pre code { padding:0; border-radius:0; color:inherit; background:transparent; }
table { width:100%; margin:12px 0 20px; border-collapse:collapse; font-size:13px; }
th,td { padding:9px 10px; border:1px solid var(--line); text-align:left; vertical-align:top; }
th { background:#f8fafc; }
.table-view { margin:12px 0 20px; }
.table-view > summary { align-items:center; gap:12px; font-weight:600; }
.table-view[open] > summary { border-bottom:1px solid var(--line); }
.table-summary-meta { margin-left:auto; font-size:12px; font-weight:400; }
.table-mount { padding:14px 14px 0; }
.table-view table { margin:0; }
.data-table td { white-space:pre-wrap; }
.table-detail-cell { width:min(520px,42vw); min-width:280px; }
.table-detail-trigger { display:block; overflow:hidden; width:100%; border:0; padding:0; color:var(--ink); background:transparent; text-align:left; text-overflow:ellipsis; white-space:nowrap; }
.table-detail-trigger:hover { color:var(--accent); background:transparent; text-decoration:underline; }
.table-detail-dialog { width:min(960px,calc(100vw - 48px)); max-width:none; max-height:calc(100vh - 48px); border:0; border-radius:12px; padding:0; color:var(--ink); background:var(--panel); box-shadow:0 24px 64px rgba(15,23,42,.28); }
.table-detail-dialog::backdrop { background:rgba(15,23,42,.5); }
.table-detail-dialog[open] { display:grid; grid-template-rows:auto minmax(0,1fr); }
.table-detail-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 18px; border-bottom:1px solid var(--line); }
.table-detail-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.table-detail-close { padding:5px 10px; }
.table-detail-content { max-height:calc(100vh - 130px); margin:0; border-radius:0 0 12px 12px; white-space:pre-wrap; }
.collection-steps-view > .table-scroll { padding:14px; }
.collection-steps-view table { margin:0; }
.inspection-facts { display:grid; gap:10px; }
.inspection-fact { margin:0; }
.inspection-fact > summary { align-items:center; color:var(--ink); }
.inspection-fact pre { max-height:420px; }
.table-scroll { overflow-x:auto; }
.table-sort { display:flex; width:100%; align-items:center; justify-content:space-between; gap:8px; border:0; padding:0; color:inherit; background:transparent; font-weight:inherit; text-align:left; }
.table-sort:hover { color:var(--accent); background:transparent; }
.sort-marker { color:#94a3b8; font-size:11px; }
th[aria-sort="ascending"] .sort-marker::before { content:"▲"; }
th[aria-sort="descending"] .sort-marker::before { content:"▼"; }
th[aria-sort]:not([aria-sort="none"]) .sort-marker { font-size:0; color:var(--accent); }
th[aria-sort]:not([aria-sort="none"]) .sort-marker::before { font-size:11px; }
.table-controls { display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:8px; margin:10px 14px 14px; color:var(--muted); font-size:12px; }
.table-controls[hidden] { display:none; }
.table-controls label { display:flex; align-items:center; gap:5px; }
.table-controls select,.table-search { border:1px solid var(--line); border-radius:6px; padding:5px 7px; color:var(--ink); background:#fff; font:inherit; }
.table-search-label { display:flex; align-items:center; gap:5px; font-size:12px; font-weight:400; cursor:default; }
.table-search { min-width:240px; }
.table-controls button { padding:5px 9px; }
.table-controls button:disabled { cursor:not-allowed; opacity:.45; }
button { cursor:pointer; border:1px solid #bfdbfe; border-radius:7px; padding:8px 12px; color:#1e40af; background:#eff6ff; font:inherit; }
details { margin:10px 0; border:1px solid var(--line); border-radius:8px; background:#fff; }
details summary { display:flex; justify-content:space-between; cursor:pointer; padding:12px 14px; color:var(--muted); }
details pre { margin:0; border-radius:0 0 8px 8px; }
.report-subsection { margin:12px 0; background:#fbfcfe; }
.report-subsection > summary { align-items:center; gap:12px; list-style:none; color:var(--ink); }
.report-subsection > summary::-webkit-details-marker { display:none; }
.report-subsection > summary h2,.report-subsection > summary h3 { flex:1; margin:0; padding:0; border:0; }
.report-subsection > summary h2 { font-size:20px; }
.report-subsection > summary h3 { font-size:16px; }
.report-subsection-body { padding:0 14px 14px; }
.section-chevron::before { display:inline-block; content:"▶"; color:var(--muted); font-size:11px; transition:transform .15s ease; }
.report-subsection[open] > summary .section-chevron::before { transform:rotate(90deg); }
.status { display:inline-block; min-width:70px; border-radius:999px; padding:2px 8px; text-align:center; font-weight:600; }
.status-ok { color:#166534; background:#dcfce7; }
.status-failed { color:#991b1b; background:#fee2e2; }
.status-unnecessary { color:#475569; background:#e2e8f0; }
.status-other { color:#854d0e; background:#fef9c3; }
.muted { color:var(--muted); }
.metric-comparison-note { margin:12px 0 6px; color:var(--muted); font-size:13px; }
.metric-grid { display:grid; grid-template-columns:1fr; gap:14px; margin:12px 0 20px; }
.metric-card { padding:16px; border:1px solid var(--line); border-radius:10px; background:#fbfcfe; }
.metric-title { margin:0 0 10px; font-size:15px; font-weight:700; }
.metric-card-critical { border-color:#fecaca; background:#fff7f7; }
.metric-card-warning { border-color:#fde68a; background:#fffbeb; }
.metric-values { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
.metric-values strong { font-size:18px; }
.metric-values span { color:var(--muted); }
.metric-track { overflow:hidden; height:18px; margin:9px 0; border-radius:999px; background:#e5e7eb; box-shadow:inset 0 1px 2px rgba(15,23,42,.12); }
.metric-fill { height:100%; min-width:2px; border-radius:inherit; background:#2563eb; }
.metric-fill-warning { background:#f59e0b; }
.metric-fill-critical { background:#dc2626; }
.metric-track-indeterminate { background:repeating-linear-gradient(135deg,#dbeafe 0,#dbeafe 10px,#eff6ff 10px,#eff6ff 20px); }
.metric-track-indeterminate .metric-fill { background:#60a5fa; opacity:.75; }
.metric-status { margin:7px 0 0; font-weight:700; }
.metric-status-critical { color:#b91c1c; }
.metric-status-warning { color:#a16207; }
.metric-detail { margin:3px 0 0; color:var(--muted); font-size:13px; }
.report-switcher > label { display:flex; align-items:center; gap:10px; margin:12px 0 18px; font-weight:700; }
.report-switcher-select { min-width:280px; border:1px solid var(--line); border-radius:7px; padding:7px 10px; color:var(--ink); background:#fff; font:inherit; }
.report-switcher-controls { display:flex; flex-wrap:wrap; gap:12px 24px; margin:12px 0 18px; }
.report-switcher-controls label { display:flex; align-items:center; gap:10px; font-weight:700; }
.report-switcher-title { margin:0 0 10px; font-weight:700; }
.report-switcher-panel h4,.report-cascade-panel h4 { margin:22px 0 8px; font-size:16px; }
.chart-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:20px; }
.line-chart-grid { display:grid; gap:20px; }
.line-chart-card { min-width:0; padding:16px; border:1px solid var(--line); border-radius:10px; background:#fbfcfe; }
.line-chart-card h3 { margin:0 0 4px; }
.line-chart-card > p { margin:0 0 8px; }
.line-chart { display:block; width:100%; min-height:220px; }
.chart-axis { stroke:#cbd5e1; stroke-width:1; }
.chart-label { fill:#64748b; font-size:11px; }
.line-chart-legend { display:flex; flex-wrap:wrap; gap:8px 20px; }
.line-chart-legend li { min-width:180px; flex:1; }
.pie-card { display:grid; grid-template-columns:160px 1fr; gap:20px; align-items:center; padding:16px; border:1px solid var(--line); border-radius:10px; }
.pie { width:160px; height:160px; border-radius:50%; box-shadow:inset 0 0 0 1px rgba(15,23,42,.08); }
.pie-card h3 { grid-column:1/-1; margin:0; }
.pie-description { grid-column:1/-1; margin:-10px 0 0; }
.legend { list-style:none; margin:0; padding:0; }
.legend li { display:grid; grid-template-columns:12px 1fr auto; gap:8px; align-items:center; margin:7px 0; }
.swatch { width:12px; height:12px; border-radius:3px; }
.bar-chart { display:grid; gap:14px; }
.bar-chart-row { padding:13px 15px; border:1px solid var(--line); border-radius:9px; background:#f8fafc; }
.bar-chart-heading { display:flex; justify-content:space-between; gap:16px; align-items:baseline; }
.bar-chart-heading code { overflow-wrap:anywhere; }
.bar-chart-heading strong { white-space:nowrap; }
.bar-chart-track { overflow:hidden; height:12px; margin-top:9px; border-radius:999px; background:#dbeafe; box-shadow:inset 0 1px 2px rgba(15,23,42,.10); }
.bar-chart-fill { height:100%; min-width:2px; border-radius:inherit; background:linear-gradient(90deg,#2563eb,#0891b2); }
.bar-chart-detail { min-height:1em; margin:6px 0 0; color:var(--muted); font-size:12px; }
.bar-chart-breakdown { margin:10px 0 0; background:#fff; }
.bar-chart-breakdown > summary { font-weight:600; }
.bar-chart-breakdown > .bar-chart { gap:10px; padding:0 12px 12px; }
@media (max-width:1100px) {
  .report-layout { display:block; padding:0 12px; }
  .sidebar { position:static; margin-bottom:16px; }
  .sidebar nav { display:flex; gap:6px; overflow-x:auto; }
  .sidebar a { white-space:nowrap; }
  section { padding:16px; }
  table { display:block; overflow-x:auto; }
  .pie-card { grid-template-columns:1fr; }
  .pie { margin:auto; }
}
@media print {
  body { background:#fff; }
  .report-header { color:#111827; background:#fff; padding:12px 0; }
  .report-header p { color:#475569; }
  .report-layout { display:block; max-width:none; margin:0; padding:0; }
  .sidebar { display:none; }
  section { break-inside:avoid; box-shadow:none; }
  .table-search-label,.table-controls { display:none !important; }
  .data-table tr[hidden] { display:table-row !important; }
  .report-switcher-panel[hidden] { display:block !important; }
  .report-cascade-panel[hidden] { display:block !important; }
}
`;
