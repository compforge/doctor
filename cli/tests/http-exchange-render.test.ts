import { expect, test } from "bun:test";
import {
  renderHttpExchangeInspector,
  renderHttpRequestEvidenceAsCurl,
} from "../src/collect/shared/http/exchange-render";
import type { HttpBodyCapture } from "../src/collect/shared/http/model";

function body(value: string, truncated = false): HttpBodyCapture {
  const bytes = Buffer.from(value);
  return {
    base64: bytes.toString("base64"),
    capturedBytes: bytes.length,
    totalBytes: truncated ? bytes.length + 20 : bytes.length,
    truncated,
  };
}

test("HTTP Exchange 对缺失 Response 和截断 Request 使用显式失败状态", () => {
  const request = {
    scheme: "http" as const,
    method: "POST",
    authority: "executor",
    path: "/run",
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Content-Length", value: "100" },
    ],
    body: body('{"partial":', true),
  };
  const html = renderHttpExchangeInspector([{
    id: "failed-request",
    label: "planner → executor",
    request,
    endedAtEpoch: 12,
    durationMs: 234.5,
    responseMissingReason: "未观察到 HTTP Response；随后观察到 TCP RST。",
  }]);
  const curl = renderHttpRequestEvidenceAsCurl(request);

  expect(html).toContain("未观察到 HTTP Response");
  expect(html).toContain("TCP RST");
  expect(html).toContain("Last transport evidence");
  expect(html).toContain("234.5 ms");
  expect(html).toContain("Request Body 已截断");
  expect(html).toContain("部分证据");
  expect(html).toContain('class="exchange-copy-block"');
  expect(html).toContain('class="exchange-copy-source"');
  expect(html).toContain(">复制 cURL</button>");
  expect(html).not.toContain("data-copy-text=");
  expect(curl).not.toContain("--data-binary");
  expect(curl).not.toContain("Content-Length");
});

test("cURL 交给客户端根据完整 Body 重新计算 Content-Length", () => {
  const curl = renderHttpRequestEvidenceAsCurl({
    method: "POST",
    authority: "executor",
    path: "/run",
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Content-Length", value: "13" },
    ],
    body: body('{"ok":true}'),
  });

  expect(curl).toContain("--data-binary");
  expect(curl).not.toContain("Content-Length");
});

test("HTTP Exchange 同时保留 SSE 原文并提供事件 Preview", () => {
  const sse = [
    "event: message",
    "id: 7",
    'data: {"type":"tool_call","name":"search"}',
    "",
    "event: done",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  const html = renderHttpExchangeInspector([{
    id: "sse-request",
    label: "executor → model-gateway",
    request: {
      method: "POST",
      authority: "model-gateway",
      path: "/v1/chat/completions",
      headers: [],
    },
    response: {
      status: 200,
      headers: [{ name: "Content-Type", value: "text/event-stream" }],
      body: body(sse),
    },
  }]);

  expect(html).toContain('data-tab-target="response"');
  expect(html).toContain('data-tab-target="stream"');
  expect(html).toContain('data-tab-target="response-preview"');
  expect(html).toContain("event: message");
  expect(html).toContain('class="exchange-sse-event-index">#1');
  expect(html).toContain('class="exchange-sse-event-type">message');
  expect(html).toContain("· id=7");
  expect(html).toContain('class="exchange-sse-event-index">#2');
  expect(html).toContain('class="exchange-sse-event-type">done');
  expect(html).toContain("Events (2)");
  expect(html).toContain("Raw event");
  expect(html).toContain("&quot;type&quot;: &quot;tool_call&quot;");
  expect(html).toContain("HTTP 200");
});

test("HTTP Exchange 不把截断的 SSE 末尾片段伪装成完整事件", () => {
  const sse = [
    "event: message",
    'data: {"complete":true}',
    "",
    "event: message",
    'data: {"partial":',
  ].join("\n");
  const html = renderHttpExchangeInspector([{
    id: "truncated-sse",
    label: "executor → model-gateway",
    request: { method: "POST", authority: "model-gateway", path: "/stream", headers: [] },
    response: {
      status: 200,
      headers: [{ name: "Content-Type", value: "text/event-stream" }],
      body: body(sse, true),
    },
  }]);

  expect(html).toContain("Events (1)");
  expect(html).toContain("1 个完整事件");
  expect(html).toContain("未完成的末尾片段");
  expect(html).toContain("Response Body 已截断");
  expect(html).toContain("data: {&quot;partial&quot;:");
});
