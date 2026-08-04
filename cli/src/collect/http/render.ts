import { readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateRaw } from "../evidence";
import { escapeHtml, htmlHeading, htmlList, htmlParagraph, htmlTable, htmlTableCell } from "../output/html";
import type {
  HttpDiagnosis,
  HttpExecution,
  HttpFinding,
  HttpRequestGroup,
  HttpRequestPlan,
} from "../shared/http/model";

const HTTP_REPORT_RESPONSE_CAP_BYTES = 64 * 1024;

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderHttpRequestAsCurl(request: HttpRequestPlan): string {
  const clauses = ["curl"];
  if (request.followRedirects) clauses.push("--location");
  clauses.push(`--request ${quotePosix(request.method)}`);
  clauses.push(`--max-time ${quotePosix(String(request.timeoutMs / 1000))}`);
  for (const [name, value] of Object.entries(request.headers)) {
    clauses.push(`--header ${quotePosix(`${name}: ${value}`)}`);
  }
  if (request.body !== undefined) {
    if (!Object.keys(request.headers).some((name) => name.toLowerCase() === "content-type")) {
      clauses.push(`--header ${quotePosix("Content-Type:")}`);
    }
    clauses.push(`--data-binary ${quotePosix(new TextDecoder().decode(request.body))}`);
  }
  clauses.push(quotePosix(request.url));
  return clauses.join(" \\\n  ");
}

function responseText(execution: HttpExecution, staging: string): string {
  const headers = readFileSync(join(staging, execution.response.headersFile), "utf-8").trimEnd();
  const body = readFileSync(join(staging, execution.response.bodyFile)).toString("utf-8");
  return truncateRaw(
    `${headers}\n\n${body || "(empty body)"}`,
    HTTP_REPORT_RESPONSE_CAP_BYTES,
    48 * 1024,
  );
}

function requestPlans(groups: readonly HttpRequestGroup[]): readonly HttpRequestPlan[] {
  return groups.flatMap((group) => group.entrypoints);
}

function requestLabel(request: Pick<HttpRequestPlan, "requestId" | "entrypointId">): string {
  return `${request.requestId}/${request.entrypointId}`;
}

function responseLabel(execution: HttpExecution): string {
  return `${requestLabel(execution)} 第 ${execution.round} 轮`;
}

function transportPeer(execution: HttpExecution): string {
  const transport = execution.response.transport;
  if (!transport?.remoteAddress) return "—";
  return transport.remotePort
    ? `${transport.remoteAddress}:${transport.remotePort}`
    : transport.remoteAddress;
}

function transportTiming(value: number | undefined): string {
  return value === undefined ? "—" : `${value} ms`;
}

function transportTimingCell(value: number | undefined) {
  return value === undefined ? "—" : htmlTableCell(`${value} ms`, value);
}

function sseFirstFrameMs(execution: HttpExecution): number | undefined {
  const firstFrameAt = execution.sse?.timeline.firstFrameAt;
  return firstFrameAt === undefined
    ? undefined
    : Math.max(0, Date.parse(firstFrameAt) - Date.parse(execution.response.startedAt));
}

function transportSummary(execution: HttpExecution): string {
  const transport = execution.response.transport;
  const parts = transport
    ? [
        `${responseLabel(execution)}：peer=${transportPeer(execution)}`,
        `dns=${transportTiming(transport.timings.dnsMs)}`,
        `tcp=${transportTiming(transport.timings.tcpMs)}`,
        `tls=${transportTiming(transport.timings.tlsMs)}`,
        `ttfb=${transportTiming(transport.timings.firstByteMs)}`,
        `total=${transportTiming(transport.timings.totalMs)}`,
        `final_url=${transport.finalUrl ?? "—"}`,
      ]
    : [`${responseLabel(execution)}：transport diagnostics unavailable`];
  if (execution.sse) {
    parts.push(
      `sse_first_frame=${transportTiming(sseFirstFrameMs(execution))}`,
      `sse_max_gap=${transportTiming(execution.sse.timeline.maxGapMs)}`,
      `sse_terminal=${execution.sse.timeline.terminalReceived}`,
    );
  }
  return parts.join("；");
}

function buildHttpExchangeHtml(
  diagnosis: HttpDiagnosis,
  groups: readonly HttpRequestGroup[],
  staging: string,
): string {
  const failed = diagnosis.executions.filter((execution) => !execution.requestSuccess);
  return [
    htmlHeading(2, "实际请求 cURL"),
    ...requestPlans(groups).flatMap((request) => [
      htmlHeading(3, requestLabel(request)),
      `<pre><code class="language-bash">${escapeHtml(renderHttpRequestAsCurl(request))}</code></pre>`,
    ]),
    ...(failed.length
      ? [
          htmlHeading(2, "异常 Response"),
          ...failed.flatMap((execution) => [
            htmlHeading(3, responseLabel(execution)),
            `<pre><code class="language-http">${escapeHtml(responseText(execution, staging))}</code></pre>`,
          ]),
        ]
      : []),
  ].join("");
}

export function buildHttpMarkdown(
  diagnosis: HttpDiagnosis,
  groups: readonly HttpRequestGroup[],
  scenarioName: string,
  execution: string,
  staging: string,
): string {
  const endpoints = diagnosis.facts.endpoints.status === "collected"
    ? diagnosis.facts.endpoints.items
    : [];
  const failed = diagnosis.executions.filter((attempt) => !attempt.requestSuccess);
  return [
    "# doctor http diagnosis",
    "",
    `- scenario: ${scenarioName}`,
    `- execution: ${execution}`,
    `- endpoints: ${endpoints.length}`,
    ...endpoints.map(
      (endpoint) => `- endpoint: ${endpoint.endpoint.authority} ${endpoint.status}${endpoint.reason ? ` (${endpoint.reason})` : ""}`,
    ),
    `- executions: ${diagnosis.executions.length}`,
    `- successful: ${diagnosis.executions.filter((attempt) => attempt.requestSuccess).length}`,
    `- failed: ${failed.length}`,
    `- findings: ${diagnosis.findings.length}`,
    ...diagnosis.findings.map((finding) => `- finding: ${renderHttpFinding(finding)}`),
    ...diagnosis.coverage.map((coverage) => `- coverage: ${coverage.goal}=${coverage.status}`),
    "",
    "## HTTP 传输观测",
    "",
    ...diagnosis.executions.map((execution) => `- ${transportSummary(execution)}`),
    "",
    "## 实际请求 cURL",
    "",
    ...requestPlans(groups).flatMap((request) => [
      `### ${requestLabel(request)}`,
      "",
      "```bash",
      renderHttpRequestAsCurl(request),
      "```",
      "",
    ]),
    ...(failed.length
      ? [
          "## 异常 Response",
          "",
          ...failed.flatMap((attempt) => [
            `### ${responseLabel(attempt)}`,
            "",
            "```http",
            responseText(attempt, staging),
            "```",
            "",
          ]),
        ]
      : []),
  ].join("\n");
}

export function renderHttpFinding(finding: HttpFinding): string {
  if (finding.kind === "http.endpoint-unreachable") {
    return `${finding.endpoint} 在 ${finding.phase.toUpperCase()} 阶段不可达：${finding.reason}；影响 ${finding.affectedRequests.join(", ")}`;
  }
  if (finding.kind === "http.endpoint-inspection-unavailable") {
    return `${finding.endpoint} 连通性 Inspect 未完成：${finding.reason}；影响 ${finding.affectedRequests.join(", ")}`;
  }
  if (finding.kind === "http.transport-failed") {
    return `${finding.requestId}/${finding.entrypointId} 第 ${finding.round} 轮传输失败：${finding.terminationReason}${finding.error ? `；${finding.error}` : ""}`;
  }
  if (finding.kind === "http.unexpected-status") {
    return `${finding.requestId}/${finding.entrypointId} 第 ${finding.round} 轮 HTTP status=${finding.actual ?? "unknown"}，期望 ${finding.expected.join(", ")}`;
  }
  if (finding.kind === "http.unexpected-content-type") {
    return `${finding.requestId}/${finding.entrypointId} 第 ${finding.round} 轮 Content-Type=${finding.actual ?? "unknown"}，期望 ${finding.expected}`;
  }
  if (finding.kind === "http.response-too-slow") {
    return `${finding.requestId}/${finding.entrypointId} 第 ${finding.round} 轮耗时 ${finding.actualMs} ms，超过 ${finding.expectedMaxMs} ms`;
  }
  if (finding.kind === "http.sse-missing-terminal-event") {
    return `${finding.requestId}/${finding.entrypointId} 第 ${finding.round} 轮 SSE 缺少终止事件 ${finding.expectedEvent}，最后事件=${finding.lastEvent ?? "unknown"}`;
  }
  if (finding.kind === "http.sse-error-event") {
    return `${finding.requestId}/${finding.entrypointId} 第 ${finding.round} 轮收到 SSE error event：code=${finding.code ?? "unknown"}，trace=${finding.traceId ?? "unknown"}`;
  }
  if (finding.kind === "http.sse-incomplete-frame") {
    return `${finding.requestId}/${finding.entrypointId} 第 ${finding.round} 轮响应结束时存在未完成的 SSE frame`;
  }
  if (finding.kind === "http.intermittent-failure") {
    return `${finding.requestId}/${finding.entrypointId} 存在偶现失败：成功 ${finding.successful} 次，失败 ${finding.failed} 次`;
  }
  return `${finding.requestId} 第 ${finding.round} 轮从 ${finding.outerEntrypoint} 到 ${finding.innerEntrypoint} 开始出现响应差异：${finding.differences.join(", ")}`;
}

export function buildHttpHtml(
  diagnosis: HttpDiagnosis,
  groups: readonly HttpRequestGroup[],
  staging: string,
  execution = "local",
): string {
  const successful = diagnosis.executions.filter((execution) => execution.requestSuccess).length;
  const findings = diagnosis.findings.length
    ? htmlList(diagnosis.findings.map((finding) => `[${finding.severity}] ${renderHttpFinding(finding)}`))
    : htmlParagraph("当前规则覆盖范围内未发现异常。");
  const endpoints = diagnosis.facts.endpoints.status === "collected"
    ? diagnosis.facts.endpoints.items
    : [];
  return [
    htmlHeading(1, "doctor http 诊断报告"),
    htmlHeading(2, "执行汇总"),
    htmlList([
      `执行位置：${execution}`,
      `执行次数：${diagnosis.executions.length}`,
      `成功：${successful}`,
      `失败：${diagnosis.executions.length - successful}`,
      `成功率：${diagnosis.executions.length ? (successful * 100 / diagnosis.executions.length).toFixed(1) : "0.0"}%`,
    ]),
    htmlHeading(2, "Inspect Facts：Endpoint 连通性"),
    endpoints.length
      ? htmlTable(
          ["endpoint", "status", "phase", "resolved addresses", "remote", "duration", "reason"],
          endpoints.map((endpoint) => [
            endpoint.endpoint.authority,
            endpoint.status,
            endpoint.phase ?? "—",
            endpoint.resolvedAddresses.join(", ") || "—",
            endpoint.remoteAddress ?? "—",
            htmlTableCell(`${endpoint.durationMs} ms`, endpoint.durationMs),
            endpoint.reason ?? "—",
          ]),
        )
      : htmlParagraph("未取得 endpoint 连通性 Facts。"),
    htmlHeading(2, "诊断结论"),
    findings,
    buildHttpExchangeHtml(diagnosis, groups, staging),
    htmlHeading(2, "按请求聚合"),
    htmlTable(
      ["request", "entrypoint", "total", "success", "failed", "success rate", "min", "p50", "p95", "max", "status distribution"],
      diagnosis.summaries.map((summary) => [
        summary.requestId,
        summary.entrypointId,
        summary.total,
        summary.successful,
        summary.failed,
        htmlTableCell(`${(summary.successRate * 100).toFixed(1)}%`, summary.successRate),
        htmlTableCell(`${summary.durationMinMs} ms`, summary.durationMinMs),
        htmlTableCell(`${summary.durationP50Ms} ms`, summary.durationP50Ms),
        htmlTableCell(`${summary.durationP95Ms} ms`, summary.durationP95Ms),
        htmlTableCell(`${summary.durationMaxMs} ms`, summary.durationMaxMs),
        Object.entries(summary.statusCounts).map(([status, count]) => `${status}: ${count}`).join(", "),
      ]),
    ),
    htmlHeading(2, "逐次执行"),
    htmlTable(
      ["round", "request", "entrypoint", "success", "status", "peer", "DNS", "TCP", "TLS", "TTFB", "duration", "content type", "bytes", "body SHA-256", "termination", "SSE first frame", "SSE max gap", "SSE terminal", "SSE frames", "findings"],
      diagnosis.executions.map((execution) => [
        execution.round,
        execution.requestId,
        execution.entrypointId,
        execution.requestSuccess,
        execution.response.statusCode ?? "—",
        transportPeer(execution),
        transportTimingCell(execution.response.transport?.timings.dnsMs),
        transportTimingCell(execution.response.transport?.timings.tcpMs),
        transportTimingCell(execution.response.transport?.timings.tlsMs),
        transportTimingCell(execution.response.transport?.timings.firstByteMs),
        htmlTableCell(`${execution.response.durationMs} ms`, execution.response.durationMs),
        execution.response.contentType ?? "—",
        execution.response.bodyBytes,
        execution.response.bodySha256,
        execution.response.terminationReason,
        transportTimingCell(sseFirstFrameMs(execution)),
        transportTimingCell(execution.sse?.timeline.maxGapMs),
        execution.sse?.timeline.terminalReceived ?? "—",
        execution.sse?.frameCount ?? "—",
        execution.findings.length,
      ]),
    ),
    htmlHeading(2, "Coverage"),
    diagnosis.coverage.length
      ? htmlTable(
          ["goal", "status", "missing evidence"],
          diagnosis.coverage.map((coverage) => [
            coverage.goal,
            coverage.status,
            coverage.missingEvidence.join("；") || "—",
          ]),
        )
      : htmlParagraph("未生成 Coverage。"),
    htmlParagraph("报告展示实际请求 cURL 与异常 Response；未截断的完整响应与每次执行 meta 请使用 --format bundle。"),
  ].join("");
}
