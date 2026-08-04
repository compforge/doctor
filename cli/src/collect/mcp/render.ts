import {
  escapeHtml,
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
} from "../output/html";
import {
  gatewayLogsObservation,
  httpCallObservation,
  mcpCallObservation,
  type McpDiagnosis,
} from "./model";

function mcpResultSummary(diagnosis: McpDiagnosis): string[] {
  const observation = mcpCallObservation(diagnosis.evidence);
  if (!observation) return ["MCP tool call 未执行或没有取得响应。"];
  if (observation.error) return [`MCP 调用失败：${observation.error}`];
  const message = observation.response;
  if (!message) return ["MCP tool call 没有取得响应。"];
  const result = message.result as { isError?: boolean; content?: unknown[] } | undefined;
  return [
    `JSON-RPC id：${message.id ?? "unknown"}`,
    `tool result isError：${String(result?.isError ?? false)}`,
    `content items：${Array.isArray(result?.content) ? result.content.length : "unknown"}`,
    "完整 JSON-RPC 响应与 SSE transcript 位于 Evidence Bundle raw 文件中。",
  ];
}

function findingSummary(diagnosis: McpDiagnosis): string[] {
  return diagnosis.findings.length
    ? diagnosis.findings.map((finding) =>
      `${finding.severity} / ${finding.kind} / confidence=${finding.confidence}：${finding.summary}`
    )
    : ["本次证据未形成异常 Finding；是否足以排除问题见诊断覆盖度。"];
}

export function buildMcpReportHtml(diagnosis: McpDiagnosis): string {
  const { facts } = diagnosis.evidence;
  const mcp = mcpCallObservation(diagnosis.evidence);
  const http = httpCallObservation(diagnosis.evidence)?.capture;
  const logs = gatewayLogsObservation(diagnosis.evidence);
  const toolRows = [...new Set([...facts.configuredTools, ...facts.runtimeTools])].map((name) => [
    name,
    facts.configuredTools.includes(name) ? "yes" : "no",
    facts.runtimeTools.includes(name) ? "yes" : "no",
  ]);
  const plan = facts.httpPlan;
  return [
    htmlHeading(1, "MCP 诊断"),
    htmlParagraph(
      `目标 ${facts.target.server.tenant}/${facts.target.server.name} · tool=${facts.target.tool.name}`,
    ),
    htmlList([
      `trace_id：${facts.traceId}`,
      `配置 tools：${facts.configuredTools.length}`,
      `runtime tools/list：${facts.runtimeTools.length}`,
      `匹配到的 gateway 日志：${logs?.matchedLines ?? 0} 行`,
    ]),
    htmlHeading(2, "诊断结论"),
    htmlList(findingSummary(diagnosis)),
    htmlHeading(2, "诊断覆盖度"),
    htmlTable(
      ["goal", "status", "missing evidence"],
      diagnosis.coverage.map((item) => [item.goal, item.status, item.missingEvidence.join("；") || "-"]),
    ),
    htmlHeading(2, "配置与运行时工具"),
    toolRows.length ? htmlTable(["tool", "产品配置", "tools/list"], toolRows) : htmlParagraph("未取得 tool 列表。"),
    htmlHeading(2, "MCP Probe"),
    htmlList(mcpResultSummary(diagnosis)),
    htmlHeading(2, "HTTP Probe"),
    htmlList([
      `method：${plan.method}`,
      `url：${plan.url}`,
      `映射限制：${plan.unsupported.length}`,
      ...plan.unsupported,
    ]),
    facts.httpCurl
      ? `${htmlHeading(3, "可复制复现 cURL")}<pre><code class="language-bash">${escapeHtml(facts.httpCurl)}</code></pre>`
      : "",
    http
      ? htmlList([
        `curl exit：${http.exitCode ?? "unknown"}`,
        `HTTP status：${http.statusCode ?? "未建立"}`,
        `耗时：${http.durationMs} ms`,
        http.stderr ? `stderr：${http.stderr.trim().split("\n")[0]}` : "stderr：空",
        "完整响应 headers 与 body 位于 Evidence Bundle raw 文件中。",
      ])
      : htmlParagraph("直接 HTTP 未执行或未取得响应。"),
    plan.warnings.length ? `${htmlHeading(3, "等价性边界")}${htmlList(plan.warnings)}` : "",
    `<p class="muted">HTML 只展示结构化 Diagnosis 与复现 cURL，不内嵌真实响应和日志；完整原始证据请使用 <code>--format bundle</code>。</p>`,
    mcp ? "" : htmlParagraph("MCP Probe 未形成 Observation，具体原因见 Evidence Bundle manifest。"),
  ].join("\n");
}

export function renderMcpSummary(diagnosis: McpDiagnosis): string {
  const { facts } = diagnosis.evidence;
  const mcp = mcpCallObservation(diagnosis.evidence);
  const http = httpCallObservation(diagnosis.evidence)?.capture;
  const logs = gatewayLogsObservation(diagnosis.evidence);
  const lines = [
    "# doctor mcp",
    "",
    `- target: ${facts.target.server.tenant}/${facts.target.server.name} tool=${facts.target.tool.name}`,
    `- trace_id: ${facts.traceId}`,
    `- config tools: ${facts.configuredTools.length}`,
    `- runtime tools: ${facts.runtimeTools.length}`,
    `- MCP response: ${mcp?.error ?? (mcp ? "collected" : "unavailable")}`,
    `- direct HTTP: ${http ? `exit=${http.exitCode}, status=${http.statusCode ?? "none"}` : "unavailable"}`,
    `- gateway log matched lines: ${logs?.matchedLines ?? 0}`,
    "",
    "## Findings",
    "",
    ...findingSummary(diagnosis).map((item) => `- ${item}`),
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.map((item) =>
      `- ${item.goal}: ${item.status}${item.missingEvidence.length ? `（缺少：${item.missingEvidence.join("；")}）` : ""}`
    ),
    ...facts.httpPlan.unsupported.map((item) => `- mapping unsupported: ${item}`),
    "",
    "完整原始证据见 raw/。",
    "",
  ];
  return lines.join("\n");
}
