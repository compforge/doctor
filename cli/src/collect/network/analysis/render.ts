import {
  escapeHtml,
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
} from "../../output/html";
import { renderHttpExchangeInspector } from "../../shared/http/exchange-render";
import type { HttpExchangeEvidence } from "../../shared/http/model";
import {
  networkArtifactObservations,
  networkHopObservations,
} from "./detector";
import type {
  NetworkAnalysisDocument,
  NetworkDiagnosis,
  NetworkFinding,
  NetworkHopObservation,
} from "./model";

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  if (durationMs < 1000) return `${durationMs.toFixed(1)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatTime(epoch: number | undefined): string {
  if (epoch === undefined) return "—";
  return new Date(epoch * 1000).toISOString();
}

function findingLabel(finding: NetworkFinding): string {
  return `[${finding.severity}/${finding.confidence}] ${finding.message}`;
}

function diagnosisConclusion(
  diagnosis: NetworkDiagnosis,
  mode: NetworkAnalysisDocument["config"]["mode"],
): string {
  const errors = diagnosis.findings.filter((finding) => finding.kind === "network.http-error");
  if (errors.length) {
    return errors.map((finding) => finding.message).join("；");
  }
  const resets = diagnosis.findings.filter((finding) => finding.kind === "network.connection-reset");
  if (resets.length) {
    return resets.map((finding) => finding.message).join("；");
  }
  const hops = networkHopObservations(diagnosis.evidence);
  if (!hops.length) {
    return mode === "watch"
      ? "守候窗口内没有重建出可见的业务 HTTP 调用；应先检查 Coverage，而不能据此断言页面操作没有到达下游。"
      : "当前证据没有重建出与 capture ID / trace ID 关联的业务 HTTP 调用；应先检查 Coverage，而不能据此断言下游未收到请求。";
  }
  const last = hops.at(-1)!;
  return `已重建 ${hops.length} 个调用观察点；最后观察到 ${last.caller} → ${last.callee} 的 ${last.method} ${last.path}。`;
}

function hopStatus(hop: NetworkHopObservation): string {
  if (hop.status !== undefined) return `HTTP ${hop.status}`;
  if (hop.termination === "reset") return "TCP RST";
  if (hop.termination === "finish") return "TCP FIN";
  return "未观察到终态";
}

function markdownTableCell(value: unknown): string {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function businessCallRows(diagnosis: NetworkDiagnosis): string[] {
  const hops = networkHopObservations(diagnosis.evidence);
  const first = hops.find((hop) => hop.startedAtEpoch !== undefined)?.startedAtEpoch;
  return hops.map((hop) => [
    first !== undefined && hop.startedAtEpoch !== undefined
      ? `+${((hop.startedAtEpoch - first) * 1000).toFixed(1)} ms`
      : "—",
    `${hop.caller} → ${hop.callee}`,
    `${hop.method} ${hop.path}`,
    hopStatus(hop),
    formatDuration(hop.durationMs),
    hop.pod,
  ].map(markdownTableCell).join(" | "));
}

function artifactRows(diagnosis: NetworkDiagnosis): string[][] {
  return networkArtifactObservations(diagnosis.evidence).map((artifact) => [
    artifact.services.join(", ") || "未映射",
    artifact.pod,
    artifact.windowComplete ? "覆盖充分" : "提前结束",
    artifact.verified ? "通过" : "失败",
    artifact.decoded ? artifact.decoder ?? "已解码" : "失败",
    artifact.reason ?? "—",
  ]);
}

function technicalTimeline(diagnosis: NetworkDiagnosis) {
  return networkHopObservations(diagnosis.evidence)
    .flatMap((hop) => hop.events.map((event) => ({
      ...event,
      observationId: hop.id,
      service: hop.observedAtServices.join(", ") || "未映射",
    })))
    .sort((left, right) => (left.timeEpoch ?? 0) - (right.timeEpoch ?? 0));
}

export function renderNetworkAnalysisMarkdown(document: NetworkAnalysisDocument): string {
  const { diagnosis } = document;
  const facts = diagnosis.evidence.facts;
  const calls = businessCallRows(diagnosis);
  const artifacts = artifactRows(diagnosis);
  const timeline = technicalTimeline(diagnosis);
  return [
    "# Doctor 网络调用诊断",
    "",
    "## 结论",
    "",
    diagnosisConclusion(diagnosis, document.config.mode),
    "",
    "## 请求与证据概览",
    "",
    `- NetBundle: ${facts.sourceBundle}`,
    `- 采集模式: ${document.config.mode === "watch" ? "守候" : "跟踪"}`,
    `- capture ID: ${facts.captureId ?? "未记录"}`,
    `- trace IDs: ${facts.traceIds.length ? facts.traceIds.join(", ") : "未观察到"}`,
    `- 主动请求状态: ${document.config.mode === "watch" ? "不适用" : facts.triggerResponse?.statusCode ?? "未取得"}`,
    `- 主动请求终态: ${document.config.mode === "watch" ? "不适用" : facts.triggerResponse?.terminationReason ?? "未记录"}`,
    `- PCAP 校验: ${document.summary.verifiedPcapCount}/${document.summary.pcapCount}`,
    `- PCAP 解码: ${document.summary.decodedPcapCount}/${document.summary.pcapCount}`,
    `- 业务调用观察点: ${document.summary.hopCount}`,
    "",
    "## 业务调用链",
    "",
    "| 相对时间 | 调用 | 请求 | 结果 | 耗时 | 观察 Pod |",
    "|---:|---|---|---|---:|---|",
    ...(calls.length ? calls.map((row) => `| ${row} |`) : ["| — | 未重建出关联调用 | — | — | — | — |"]),
    "",
    "## Findings",
    "",
    ...(diagnosis.findings.length
      ? diagnosis.findings.map((finding) => `- ${findingLabel(finding)}`)
      : ["- 当前规则未发现明确的 HTTP 错误、TCP RST 或响应缺失。"]),
    "",
    "## Coverage",
    "",
    "| 目标 | 状态 | 缺少证据 |",
    "|---|---|---|",
    ...diagnosis.coverage.map((coverage) =>
      `| ${coverage.goal} | ${coverage.status} | ${markdownTableCell(coverage.missingEvidence.join("；") || "—")} |`
    ),
    "",
    "## 抓包覆盖矩阵",
    "",
    "| Service | Pod | 观测窗口 | SHA256 | 解码 | 说明 |",
    "|---|---|---|---|---|---|",
    ...artifacts.map((row) => `| ${row.map(markdownTableCell).join(" | ")} |`),
    "",
    "## 技术时间线",
    "",
    "| Time | Service | Pod | Stream | Event | Source → Destination | Detail |",
    "|---|---|---|---|---|---|---|",
    ...timeline.map((event) => {
      const detail = event.kind === "request"
        ? `${event.method ?? ""} ${event.host ?? ""}${event.path ?? ""}`
        : event.kind === "response"
          ? `HTTP ${event.status}`
          : event.kind.toUpperCase();
      return `| ${[
        formatTime(event.timeEpoch),
        event.service,
        event.pod,
        event.tcpStream ?? "—",
        event.kind,
        `${event.source} → ${event.destination}`,
        detail,
      ].map(markdownTableCell).join(" | ")} |`;
    }),
    "",
    "> “未观察到”不等于“下游未收到”。只有观测窗口覆盖充分、协议可见且目标请求可定位时，才能提高相关结论的置信度。",
    "",
  ].join("\n");
}

function shortLabel(value: string, max = 24): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function inspectorAttributes(hop: NetworkHopObservation): string {
  const label = `${hop.caller} → ${hop.callee} ${hop.method} ${hop.path}`;
  return `class="network-request-selectable" data-inspector-id="${escapeHtml(hop.id)}" role="button" tabindex="0" aria-label="${escapeHtml(`查看 ${label} 的 Request 与 Response`)}"`;
}

function responseMissingReason(hop: NetworkHopObservation): string {
  if (hop.termination === "reset") {
    return "未观察到 HTTP Response；随后观察到 TCP RST。";
  }
  if (hop.termination === "finish") {
    return "未观察到 HTTP Response；随后观察到 TCP FIN。";
  }
  return "抓包窗口结束时连接仍未出现可解析的 HTTP Response。";
}

function httpExchanges(hops: readonly NetworkHopObservation[]): HttpExchangeEvidence[] {
  return hops.map((hop) => ({
    id: hop.id,
    label: `${hop.caller} → ${hop.callee}`,
    request: hop.request,
    response: hop.response,
    endedAtEpoch: hop.responseAtEpoch,
    durationMs: hop.durationMs,
    responseMissingReason: hop.response ? undefined : responseMissingReason(hop),
  }));
}

function sequenceDiagram(hops: readonly NetworkHopObservation[]): string {
  if (!hops.length) return htmlParagraph("没有可绘制的业务调用。");
  const actors = [...new Set(hops.flatMap((hop) => [hop.caller, hop.callee]))];
  const laneWidth = 190;
  const margin = 70;
  const width = Math.max(760, margin * 2 + laneWidth * Math.max(actors.length - 1, 1));
  const height = 85 + hops.length * 58;
  const x = (actor: string) => margin + actors.indexOf(actor) * laneWidth;
  const lanes = actors.map((actor) => `
    <text x="${x(actor)}" y="24" text-anchor="middle" font-size="13" font-weight="700">${escapeHtml(shortLabel(actor))}</text>
    <line x1="${x(actor)}" y1="38" x2="${x(actor)}" y2="${height - 20}" stroke="#cbd5e1" stroke-dasharray="4 5"/>`).join("");
  const arrows = hops.map((hop, index) => {
    const y = 65 + index * 58;
    const from = x(hop.caller);
    const to = x(hop.callee);
    const color = (hop.status ?? 0) >= 400 || hop.termination === "reset" ? "#dc2626" : "#2563eb";
    const result = hopStatus(hop);
    return `
      <g ${inspectorAttributes(hop)}>
        <title>查看 Request / Response</title>
        <line x1="${from}" y1="${y}" x2="${to}" y2="${y}" stroke="transparent" stroke-width="28"/>
        <line x1="${from}" y1="${y}" x2="${to}" y2="${y}" stroke="${color}" stroke-width="2" marker-end="url(#doctor-arrow)"/>
        <text x="${(from + to) / 2}" y="${y - 8}" text-anchor="middle" font-size="12" fill="#334155">${escapeHtml(shortLabel(`${hop.method} ${hop.path}`, 38))}</text>
        <text x="${(from + to) / 2}" y="${y + 17}" text-anchor="middle" font-size="11" fill="${color}">${escapeHtml(`${result} · ${formatDuration(hop.durationMs)}`)}</text>
      </g>`;
  }).join("");
  return `<div style="overflow-x:auto"><svg role="img" aria-label="业务调用泳道图" viewBox="0 0 ${width} ${height}" style="min-width:${width}px;width:100%;height:auto">
    <defs><marker id="doctor-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker></defs>
    ${lanes}${arrows}
  </svg></div>`;
}

function waterfallDiagram(hops: readonly NetworkHopObservation[]): string {
  const timed = hops.filter((hop) => hop.startedAtEpoch !== undefined);
  if (!timed.length) return htmlParagraph("调用缺少可绘制的时间信息。");
  const first = Math.min(...timed.map((hop) => hop.startedAtEpoch!));
  const last = Math.max(...timed.map((hop) => hop.responseAtEpoch ?? hop.startedAtEpoch!));
  const range = Math.max(last - first, 0.001);
  const labelWidth = 270;
  const chartWidth = 700;
  const width = labelWidth + chartWidth + 30;
  const height = 45 + timed.length * 42;
  const rows = timed.map((hop, index) => {
    const y = 35 + index * 42;
    const start = labelWidth + ((hop.startedAtEpoch! - first) / range) * chartWidth;
    const endEpoch = hop.responseAtEpoch ?? hop.startedAtEpoch!;
    const barWidth = Math.max(4, ((endEpoch - hop.startedAtEpoch!) / range) * chartWidth);
    const color = (hop.status ?? 0) >= 400 || hop.termination === "reset" ? "#dc2626" : "#2563eb";
    return `
      <g ${inspectorAttributes(hop)}>
        <title>查看 Request / Response</title>
        <rect x="0" y="${y - 6}" width="${width}" height="30" fill="transparent"/>
        <text x="0" y="${y + 12}" font-size="12" fill="#334155">${escapeHtml(shortLabel(`${hop.caller} → ${hop.callee}`, 34))}</text>
        <rect x="${start}" y="${y}" width="${barWidth}" height="18" rx="4" fill="${color}"/>
        <text x="${Math.min(start + barWidth + 7, width - 80)}" y="${y + 13}" font-size="11" fill="#475569">${escapeHtml(formatDuration(hop.durationMs))}</text>
      </g>`;
  }).join("");
  return `<div style="overflow-x:auto"><svg role="img" aria-label="调用时间瀑布图" viewBox="0 0 ${width} ${height}" style="min-width:${width}px;width:100%;height:auto">${rows}</svg></div>`;
}

function coverageCards(diagnosis: NetworkDiagnosis): string {
  const cards = diagnosis.coverage.map((coverage) => {
    const tone = coverage.status === "sufficient"
      ? { border: "#86efac", background: "#f0fdf4", text: "#166534" }
      : coverage.status === "partial"
        ? { border: "#fde68a", background: "#fffbeb", text: "#a16207" }
        : { border: "#fecaca", background: "#fff7f7", text: "#b91c1c" };
    const missing = coverage.missingEvidence.length
      ? `<ul style="margin:10px 0 0;padding-left:20px;color:#667085">${coverage.missingEvidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : '<p style="margin:10px 0 0;color:#667085">所需证据已取得。</p>';
    return `<article style="border:1px solid ${tone.border};border-radius:10px;padding:14px;background:${tone.background}">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <strong>${escapeHtml(coverage.goal)}</strong>
        <span style="border-radius:999px;padding:2px 9px;color:${tone.text};background:#fff;font-weight:700">${escapeHtml(coverage.status)}</span>
      </div>
      ${missing}
    </article>`;
  }).join("");
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">${cards}</div>`;
}

export function buildNetworkAnalysisHtml(document: NetworkAnalysisDocument): string {
  const { diagnosis } = document;
  const facts = diagnosis.evidence.facts;
  const hops = networkHopObservations(diagnosis.evidence);
  const artifacts = artifactRows(diagnosis);
  const timeline = technicalTimeline(diagnosis);
  return [
    htmlHeading(1, "网络调用诊断"),
    htmlHeading(2, "结论"),
    htmlParagraph(diagnosisConclusion(diagnosis, document.config.mode)),
    htmlHeading(2, "请求与证据概览"),
    htmlList([
      `NetBundle: ${facts.sourceBundle}`,
      `采集模式: ${document.config.mode === "watch" ? "守候" : "跟踪"}`,
      `capture ID: ${facts.captureId ?? "未记录"}`,
      `trace IDs: ${facts.traceIds.length ? facts.traceIds.join(", ") : "未观察到"}`,
      `主动请求状态: ${document.config.mode === "watch" ? "不适用" : facts.triggerResponse?.statusCode ?? "未取得"}`,
      `主动请求终态: ${document.config.mode === "watch" ? "不适用" : facts.triggerResponse?.terminationReason ?? "未记录"}`,
      `PCAP 校验: ${document.summary.verifiedPcapCount}/${document.summary.pcapCount}`,
      `PCAP 解码: ${document.summary.decodedPcapCount}/${document.summary.pcapCount}`,
      `业务调用观察点: ${document.summary.hopCount}`,
    ]),
    htmlHeading(2, "业务调用泳道"),
    '<p class="muted">点击或右键泳道箭头、瀑布行，可在右侧查看 Request 与 Response；cURL 只是 Request 的一种展示形态。未解析或已截断的内容不会被补造。</p>',
    sequenceDiagram(hops),
    htmlHeading(2, "调用时间瀑布"),
    waterfallDiagram(hops),
    htmlHeading(2, "Findings"),
    htmlList(diagnosis.findings.length
      ? diagnosis.findings.map(findingLabel)
      : ["当前规则未发现明确的 HTTP 错误、TCP RST 或响应缺失。"]),
    htmlHeading(2, "Coverage"),
    coverageCards(diagnosis),
    htmlHeading(2, "抓包覆盖矩阵"),
    htmlTable(["Service", "Pod", "观测窗口", "SHA256", "解码", "说明"], artifacts),
    htmlHeading(2, "技术时间线"),
    htmlTable(
      ["Time", "Service", "Pod", "Stream", "Event", "Source → Destination", "Detail"],
      timeline.map((event) => [
        formatTime(event.timeEpoch),
        event.service,
        event.pod,
        event.tcpStream ?? "—",
        event.kind,
        `${event.source} → ${event.destination}`,
        event.kind === "request"
          ? `${event.method ?? ""} ${event.host ?? ""}${event.path ?? ""}`
          : event.kind === "response"
            ? `HTTP ${event.status}`
            : event.kind.toUpperCase(),
      ]),
    ),
    htmlParagraph("“未观察到”不等于“下游未收到”。只有观测窗口覆盖充分、协议可见且目标请求可定位时，才能提高相关结论的置信度。"),
  ].join("");
}

export function buildNetworkAnalysisInspector(document: NetworkAnalysisDocument): string {
  return renderHttpExchangeInspector(httpExchanges(networkHopObservations(document.diagnosis.evidence)));
}
