import { escapeHtml } from "../../output/html";
import type {
  HttpBodyCapture,
  HttpExchangeEvidence,
  HttpHeaderField,
  HttpRequestEvidence,
  HttpResponseEvidence,
} from "./model";
import { parseSseCapture, type ParsedSseEvent } from "./sse";

interface Tab {
  key: string;
  label: string;
  html: string;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requestUrl(request: HttpRequestEvidence): string {
  if (/^https?:\/\//i.test(request.path)) return request.path;
  const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
  return `${request.scheme ?? "http"}://${request.authority ?? "unknown"}${path}`;
}

function bodyBytes(body: HttpBodyCapture): Uint8Array {
  return Buffer.from(body.base64, "base64");
}

function bodyText(body: HttpBodyCapture): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes(body));
  } catch {
    return undefined;
  }
}

function headerValue(headers: readonly HttpHeaderField[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function isSse(headers: readonly HttpHeaderField[]): boolean {
  return headerValue(headers, "content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

export function renderHttpRequestEvidenceAsCurl(request: HttpRequestEvidence): string {
  const clauses = [
    "curl",
    `--request ${quotePosix(request.method)}`,
    ...request.headers
      .filter((header) =>
        !header.name.startsWith(":")
        // cURL 用于让用户复制后重放请求；沿用抓包时的长度会在 Body 编码或人工修改后导致调用失败。
        // 原始 Content-Length 仍保留在 Request Headers / Raw，这里只让 cURL 按实际 Body 重新计算。
        && header.name.toLowerCase() !== "content-length"
      )
      .map((header) => `--header ${quotePosix(`${header.name}: ${header.value}`)}`),
  ];
  const text = request.body && !request.body.truncated ? bodyText(request.body) : undefined;
  if (text !== undefined) clauses.push(`--data-binary ${quotePosix(text)}`);
  clauses.push(quotePosix(requestUrl(request)));
  return clauses.join(" \\\n  ");
}

function renderHeaders(headers: readonly HttpHeaderField[]): string {
  if (!headers.length) return '<p class="muted">未从报文中解析出 Header。</p>';
  return `<div class="exchange-header-list">${headers.map((header) =>
    `<div><code>${escapeHtml(header.name)}</code><span>${escapeHtml(header.value)}</span></div>`
  ).join("")}</div>`;
}

function renderBodyState(body: HttpBodyCapture): string {
  return body.truncated
    ? `<p class="exchange-body-note">部分证据：已保留 ${body.capturedBytes}/${body.totalBytes} bytes，内容已截断。</p>`
    : `<p class="exchange-body-note">${body.totalBytes} bytes</p>`;
}

function renderRawBody(body: HttpBodyCapture | undefined): string {
  if (!body) return '<p class="muted">报文中未观察到 Body。</p>';
  const text = bodyText(body);
  if (text === undefined) {
    return `${renderBodyState(body)}<pre><code>base64:${escapeHtml(body.base64)}</code></pre>`;
  }
  return `${renderBodyState(body)}<pre><code>${escapeHtml(text)}</code></pre>`;
}

function renderJsonOrText(text: string): string {
  try {
    return `<pre class="exchange-json-preview"><code>${escapeHtml(JSON.stringify(JSON.parse(text), null, 2))}</code></pre>`;
  } catch {
    return `<pre><code>${escapeHtml(text)}</code></pre>`;
  }
}

function renderBodyPreview(
  body: HttpBodyCapture | undefined,
  headers: readonly HttpHeaderField[],
): string {
  if (!body) return '<p class="muted">没有可预览的 Body。</p>';
  const contentType = headerValue(headers, "content-type")?.toLowerCase() ?? "";
  const text = bodyText(body);
  if (text === undefined) {
    return `${renderBodyState(body)}<p class="muted">二进制内容没有文本预览；请在 Raw 中查看 base64。</p>`;
  }
  return renderBodyState(body) + (contentType.includes("json")
    ? renderJsonOrText(text)
    : `<pre><code>${escapeHtml(text)}</code></pre>`);
}

function renderRawRequest(request: HttpRequestEvidence): string {
  const start = `${request.method} ${request.path} ${request.httpVersion ?? ""}`.trim();
  const headers = request.headers.map((header) => `${header.name}: ${header.value}`).join("\r\n");
  const text = request.body ? bodyText(request.body) : undefined;
  const raw = [start, headers, text].filter((part) => part !== undefined && part.length > 0).join("\r\n\r\n");
  return `${request.body ? renderBodyState(request.body) : ""}<pre><code>${escapeHtml(raw)}</code></pre>`;
}

function renderRawResponse(response: HttpResponseEvidence): string {
  const start = `${response.httpVersion ?? "HTTP"} ${response.status} ${response.reasonPhrase ?? ""}`.trim();
  const headers = response.headers.map((header) => `${header.name}: ${header.value}`).join("\r\n");
  const text = response.body ? bodyText(response.body) : undefined;
  const raw = [start, headers, text].filter((part) => part !== undefined && part.length > 0).join("\r\n\r\n");
  return `${response.body ? renderBodyState(response.body) : ""}<pre><code>${escapeHtml(raw)}</code></pre>`;
}

function renderTabGroup(tabs: readonly Tab[], secondary = false): string {
  return `<div class="exchange-tab-group${secondary ? " exchange-tab-group-secondary" : ""}" data-tab-group>
    <div class="exchange-tab-list" role="tablist">${tabs.map((tab, index) =>
      `<button type="button" role="tab" data-tab-target="${escapeHtml(tab.key)}" aria-selected="${index === 0}">${escapeHtml(tab.label)}</button>`
    ).join("")}</div>
    <div class="exchange-tab-panels">${tabs.map((tab, index) =>
      `<div class="exchange-tab-panel" role="tabpanel" data-tab-panel="${escapeHtml(tab.key)}"${index === 0 ? "" : " hidden"}>${tab.html}</div>`
    ).join("")}</div>
  </div>`;
}

function renderSseEventPreview(event: ParsedSseEvent): string {
  if (event.data.length > 0) return renderJsonOrText(event.data);
  if (event.comments.length > 0) {
    return `<pre><code>${escapeHtml(event.comments.map((comment) => `: ${comment}`).join("\n"))}</code></pre>`;
  }
  return '<p class="muted">该事件没有 data。</p>';
}

function eventSummary(event: ParsedSseEvent): string {
  if (event.data === "[DONE]") return "[DONE]";
  if (event.data.length > 0) return event.data.replace(/\s+/g, " ").slice(0, 180);
  if (event.comments.length > 0) return event.comments.join(" · ");
  return "empty event";
}

function renderSse(body: HttpBodyCapture): string {
  const text = bodyText(body);
  if (text === undefined) {
    return `${renderBodyState(body)}<p class="muted">SSE Body 不是有效 UTF-8，只能在 Raw 中查看 base64。</p>`;
  }
  const parsed = parseSseCapture(text);
  const events = parsed.events.map((event) => `
    <details class="exchange-sse-event">
      <summary>
        <span class="exchange-sse-event-index">#${event.index}</span>
        <span class="exchange-sse-event-type">${escapeHtml(event.event ?? (event.comments.length ? "comment" : "message"))}</span>
        <span class="exchange-sse-event-summary">${escapeHtml(eventSummary(event))}</span>
        <span class="exchange-sse-event-bytes">${event.bytes} B${event.id ? ` · id=${escapeHtml(event.id)}` : ""}${event.retry ? ` · retry=${escapeHtml(event.retry)}` : ""}</span>
      </summary>
      <div class="exchange-sse-event-content">
        <div><h4>Preview</h4>${renderSseEventPreview(event)}</div>
        <div><h4>Raw event</h4><pre><code>${escapeHtml(event.raw)}</code></pre></div>
      </div>
    </details>`).join("");
  const trailing = parsed.trailingRaw
    ? `<details class="exchange-sse-event exchange-sse-trailing" open>
        <summary><strong>未完成的末尾片段</strong><span>${parsed.trailingBytes} B · 未遇到 SSE 空行分隔符</span></summary>
        <pre><code>${escapeHtml(parsed.trailingRaw)}</code></pre>
      </details>`
    : "";
  const warning = body.truncated
    ? '<p class="exchange-stream-warning">Response Body 已截断；以下事件只代表已抓到的前缀。</p>'
    : parsed.trailingRaw
    ? '<p class="exchange-stream-warning">末尾片段尚未形成完整 SSE event，未计入事件列表。</p>'
    : "";
  const eventView = `<div class="exchange-sse-view">
    ${renderBodyState(body)}
    ${warning}
    <div class="exchange-sse-toolbar"><strong>${parsed.events.length} 个完整事件</strong><input class="exchange-sse-search" type="search" placeholder="过滤 event / id / data"></div>
    <div class="exchange-sse-events">${events || '<p class="muted">未解析出完整 SSE event。</p>'}${trailing}</div>
  </div>`;
  return renderTabGroup([
    { key: "events", label: `Events (${parsed.events.length})`, html: eventView },
    { key: "raw-stream", label: "Raw", html: renderRawBody(body) },
  ], true);
}

function responseOutcome(exchange: HttpExchangeEvidence): {
  tone: "ok" | "warning" | "failed";
  label: string;
} {
  if (!exchange.response) {
    return { tone: "failed", label: "未观察到 HTTP Response" };
  }
  const requestContentLength = Number(headerValue(exchange.request.headers, "content-length"));
  const responseContentLength = Number(headerValue(exchange.response.headers, "content-length"));
  const requestBodyMissing = (
    requestContentLength > 0 || headerValue(exchange.request.headers, "transfer-encoding") !== undefined
  ) && !exchange.request.body;
  const responseMayHaveBody = exchange.request.method.toUpperCase() !== "HEAD"
    && exchange.response.status >= 200
    && exchange.response.status !== 204
    && exchange.response.status !== 304;
  const responseBodyMissing = responseMayHaveBody && (
    responseContentLength > 0
    || headerValue(exchange.response.headers, "transfer-encoding") !== undefined
  ) && !exchange.response.body;
  if (
    exchange.request.body?.truncated
    || exchange.response.body?.truncated
    || requestBodyMissing
    || responseBodyMissing
  ) {
    return { tone: "warning", label: "HTTP Exchange 仅取得部分 Body" };
  }
  if (exchange.response.status >= 400) {
    return { tone: "failed", label: `HTTP ${exchange.response.status}` };
  }
  return { tone: "ok", label: `HTTP ${exchange.response.status}` };
}

function formatObservedAt(epoch: number | undefined): string {
  return epoch === undefined ? "未记录" : new Date(epoch * 1000).toISOString();
}

function renderExchange(exchange: HttpExchangeEvidence): string {
  const request = exchange.request;
  const response = exchange.response;
  const curl = renderHttpRequestEvidenceAsCurl(request);
  const outcome = responseOutcome(exchange);
  const requestBodyWarning = request.body?.truncated
    ? '<p class="exchange-body-note">Request Body 已截断，cURL 不包含不完整的 Payload。</p>'
    : "";
  const requestStart = `${request.method} ${request.path} ${request.httpVersion ?? ""}`.trim();
  const responseStart = response
    ? `${response.httpVersion ?? "HTTP"} ${response.status} ${response.reasonPhrase ?? ""}`.trim()
    : "未观察到 HTTP Response";
  const overview = `<div class="exchange-overview">
    <div class="exchange-overview-card"><h3>Request</h3><p><code>${escapeHtml(requestStart)}</code></p><p class="muted">${escapeHtml(formatObservedAt(request.observedAtEpoch))}</p></div>
    <div class="exchange-overview-card"><h3>Response</h3><p><code>${escapeHtml(responseStart)}</code></p><p class="muted">${escapeHtml(response
      ? formatObservedAt(response.observedAtEpoch)
      : exchange.responseMissingReason ?? "抓包窗口内未观察到 Response。")}</p></div>
  </div>`;
  const requestPanel = renderTabGroup([
    { key: "request-preview", label: "Preview", html: renderBodyPreview(request.body, request.headers) },
    { key: "request-headers", label: "Headers", html: renderHeaders(request.headers) },
    {
      key: "request-curl",
      label: "cURL",
      html: `<div class="exchange-copy-block"><button type="button" class="copy-text-button">复制 cURL</button><pre><code class="exchange-copy-source">${escapeHtml(curl)}</code></pre></div>${requestBodyWarning}`,
    },
    { key: "request-raw", label: "Raw", html: renderRawRequest(request) },
  ], true);
  const responsePanel = response
    ? renderTabGroup([
      { key: "response-preview", label: "Preview", html: renderBodyPreview(response.body, response.headers) },
      { key: "response-headers", label: "Headers", html: renderHeaders(response.headers) },
      { key: "response-raw", label: "Raw", html: renderRawResponse(response) },
    ], true)
    : `<p class="exchange-missing-response">${escapeHtml(exchange.responseMissingReason ?? "抓包窗口内未观察到 Response。")}</p>`;
  const timing = `<div class="exchange-timing">
    <span>Request observed</span><code>${escapeHtml(formatObservedAt(request.observedAtEpoch))}</code>
    <span>${response ? "Response observed" : "Last transport evidence"}</span><code>${escapeHtml(formatObservedAt(response?.observedAtEpoch ?? exchange.endedAtEpoch))}</code>
    <span>Elapsed</span><code>${exchange.durationMs === undefined ? "未记录" : `${exchange.durationMs.toFixed(1)} ms`}</code>
  </div>`;
  const tabs: Tab[] = [
    { key: "overview", label: "总览", html: overview },
    { key: "request", label: "Request", html: requestPanel },
    { key: "response", label: "Response", html: responsePanel },
  ];
  if (response?.body && isSse(response.headers)) {
    tabs.push({ key: "stream", label: "Stream", html: renderSse(response.body) });
  }
  tabs.push({ key: "timing", label: "Timing", html: timing });

  return `<article class="http-exchange-detail">
    <header>
      <strong>${escapeHtml(exchange.label)}</strong>
      <span>${escapeHtml(request.method)} ${escapeHtml(request.path)}</span>
      <span class="exchange-outcome exchange-outcome-${outcome.tone}">${escapeHtml(outcome.label)}</span>
    </header>
    ${renderTabGroup(tabs)}
  </article>`;
}

export function renderHttpExchangeInspector(
  exchanges: readonly HttpExchangeEvidence[],
): string {
  return `<div class="http-exchange-inspector">
    <div class="inspector-selection" hidden></div>
    ${exchanges.map((exchange) =>
      `<template data-inspector-template="${escapeHtml(exchange.id)}">${renderExchange(exchange)}</template>`
    ).join("")}
  </div>`;
}
