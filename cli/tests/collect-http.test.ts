import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureHttpResponse,
  defaultHttpBundleName,
  diagnoseHttp,
  filterHttpScenarioRequests,
  findHttpScenarioFiles,
  loadHttpScenario,
  parseHttpOutputFormat,
  renderHttpRequestAsCurl,
  resolveHttpScenarioFile,
  resolveHttpScenarioRequests,
  resolveHttpOutputPath,
  runCollectHttp,
  writeHttpScenarioExample,
} from "../src/collect/http";
import { detectHttpAttempt } from "../src/collect/http/detector";
import { resolveHttpScenarioEndpoints } from "../src/collect/http/fact/inspect";
import type { HttpExecution, HttpRequestGroup, HttpRequestPlan } from "../src/collect/shared/http/model";
import {
  sendHttpRequest,
  type HttpTransportResponse,
  type InspectHttpEndpoint,
} from "../src/infra/http";
import { CommandContext } from "../src/command";

const encoder = new TextEncoder();

const createCommandContext = () => new CommandContext({});

const reachableEndpoint: InspectHttpEndpoint = async (endpoint) => ({
  reachable: true,
  phase: "tcp",
  resolvedAddresses: [endpoint.host],
  remoteAddress: endpoint.host,
  durationMs: 1,
});

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function response(
  statusCode: number,
  contentType: string,
  ...chunks: string[]
): HttpTransportResponse {
  return {
    statusCode,
    statusText: statusCode === 200
      ? "OK"
      : statusCode === 400
        ? "Bad Request"
        : "Internal Server Error",
    headers: { "content-type": contentType, "x-request-id": "request-1" },
    body: stream(...chunks),
  };
}

function request(overrides: Partial<HttpRequestPlan> = {}): HttpRequestPlan {
  return {
    requestId: "chat",
    entrypointId: "default",
    method: "POST",
    url: "https://example.test/chats",
    headers: { "Content-Type": "application/json" },
    body: encoder.encode('{"query":"hello"}'),
    followRedirects: true,
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    expect: { status: [200], contentType: "text/event-stream", sseTerminalEvent: "end" },
    ...overrides,
  };
}

describe("loadHttpScenario", () => {
  test("解析多请求、场景级配置与三种 body 来源", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-config-"));
    writeFileSync(join(dir, "payload.txt"), "raw-file");
    const path = join(dir, "requests.yaml");
    writeFileSync(path, `schema: doctor-http/v1
name: flaky-chat
timeout_seconds: 10
max_response_mib: 8
follow_redirects: false
headers:
  Authorization: Bearer token
requests:
  - id: json
    method: POST
    url: https://example.test/json
    json:
      query: hello
    expect:
      status: [200, 201]
  - id: raw
    method: POST
    url: https://example.test/raw
    timeout_seconds: 2
    max_response_mib: 1
    follow_redirects: true
    headers:
      Authorization: Bearer request-token
    body: text
  - id: file
    method: POST
    url: https://example.test/file
    body_file: ./payload.txt
`);

    const scenario = loadHttpScenario(path);
    expect(scenario.name).toBe("flaky-chat");
    expect(scenario.requests).toHaveLength(3);
    expect(new TextDecoder().decode(scenario.requests[0]!.entrypoints[0]!.body)).toBe('{"query":"hello"}');
    expect(scenario.requests[0]!.entrypoints[0]!.headers).toEqual({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    expect(scenario.requests[0]!.entrypoints[0]!.expect.status).toEqual([200, 201]);
    expect(scenario.requests[0]!.entrypoints[0]).toMatchObject({
      timeoutMs: 10_000,
      maxResponseBytes: 8 * 1024 * 1024,
      followRedirects: false,
    });
    expect(scenario.requests[1]!.entrypoints[0]).toMatchObject({
      timeoutMs: 2_000,
      maxResponseBytes: 1024 * 1024,
      followRedirects: true,
      headers: { Authorization: "Bearer request-token" },
    });
    expect(new TextDecoder().decode(scenario.requests[2]!.entrypoints[0]!.body)).toBe("raw-file");
    expect(scenario.requests[2]!.entrypoints[0]!.timeoutMs).toBe(10_000);

    const overridden = loadHttpScenario(path, { timeoutSeconds: 3, maxResponseMiB: 4 });
    expect(overridden.requests[1]!.entrypoints[0]).toMatchObject({
      timeoutMs: 3_000,
      maxResponseBytes: 4 * 1024 * 1024,
    });
  });

  test("同一逻辑请求复用 body，并让有序 entrypoints 覆盖 URL/header", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-entrypoints-"));
    const path = join(dir, "requests.yaml");
    writeFileSync(path, `schema: doctor-http/v1
requests:
  - id: chat
    method: POST
    url: https://platform.test/chats
    headers:
      Content-Type: application/json
      X-Common: common
    json:
      query: hello
    entrypoints:
      - id: edge-gateway
        headers:
          Host: platform.test
      - id: proxy
        url: https://proxy.test/chats
        headers:
          Host: proxy.test
      - id: frontend
        url: http://10.0.0.8:8000/chats
        headers:
          Host: frontend
    compare:
      body: exact
      sse_events: true
`);

    const group = loadHttpScenario(path).requests[0]!;
    expect(group.entrypoints.map((entrypoint) => entrypoint.entrypointId)).toEqual([
      "edge-gateway",
      "proxy",
      "frontend",
    ]);
    expect(group.entrypoints.map((entrypoint) => entrypoint.headers.Host)).toEqual([
      "platform.test",
      "proxy.test",
      "frontend",
    ]);
    expect(group.entrypoints.map((entrypoint) => entrypoint.url)).toEqual([
      "https://platform.test/chats",
      "https://proxy.test/chats",
      "http://10.0.0.8:8000/chats",
    ]);
    expect(group.entrypoints.every((entrypoint) =>
      new TextDecoder().decode(entrypoint.body) === '{"query":"hello"}'
    )).toBe(true);
    expect(group.compare).toEqual({ body: "exact", sseEvents: true });
  });

  test("拒绝重复 id、GET body 和多种 body", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-invalid-"));
    const path = join(dir, "requests.yaml");
    writeFileSync(path, `schema: doctor-http/v1
requests:
  - id: same
    url: https://example.test/a
    body: invalid
    json: {}
  - id: same
    url: https://example.test/b
`);
    expect(() => loadHttpScenario(path)).toThrow("格式错误");
  });
});

describe("HTTP 场景文件入口", () => {
  test("生成通用 HTTP API 的 example.yaml，且不覆盖已有文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-example-"));
    const path = join(dir, "example.yaml");

    expect(writeHttpScenarioExample(path)).toBe(path);
    const scenario = loadHttpScenario(path);
    expect(scenario.requests.map((request) => request.id)).toEqual(["create-item", "health"]);
    const entrypoints = scenario.requests[0]!.entrypoints;
    expect(entrypoints.map((entrypoint) => entrypoint.entrypointId)).toEqual([
      "edge-gateway",
      "proxy",
      "api",
    ]);
    expect(entrypoints.map((entrypoint) => entrypoint.headers.Host)).toEqual([
      "edge-gateway.example.test",
      "proxy.example.test",
      "api.example.test",
    ]);
    expect(entrypoints.map((entrypoint) => entrypoint.url)).toEqual([
      "http://api.example.test:8080/v1/items",
      "http://proxy.example.test:8080/v1/items",
      "http://api.example.test:8080/v1/items",
    ]);
    expect(entrypoints[0]).toMatchObject({
      method: "POST",
      url: "http://api.example.test:8080/v1/items",
      headers: {
        "X-Tenant-ID": "example-tenant",
        "Content-Type": "application/json",
      },
    });
    expect(readFileSync(path, "utf-8")).toContain("message: hello");
    const health = scenario.requests[1]!.entrypoints[0]!;
    expect(health).toMatchObject({
      method: "GET",
      url: "http://api.example.test:8080/health",
    });
    expect(health.body).toBeUndefined();
    expect(() => writeHttpScenarioExample(path)).toThrow("已存在");
  });

  test("显式 request 选择支持单个、多个与未知 id 校验", () => {
    const scenario = {
      schema: "doctor-http/v1" as const,
      name: "example",
      requests: [
        { id: "chat", entrypoints: [], compare: { body: "none" as const, sseEvents: true } },
        { id: "judge", entrypoints: [], compare: { body: "none" as const, sseEvents: true } },
      ],
    };

    expect(filterHttpScenarioRequests(scenario, ["judge"]).requests.map((request) => request.id)).toEqual(["judge"]);
    expect(filterHttpScenarioRequests(scenario, ["judge", "chat"]).requests.map((request) => request.id))
      .toEqual(["chat", "judge"]);
    expect(() => filterHttpScenarioRequests(scenario, ["missing"]))
      .toThrow("未找到 request: missing；可选值: chat, judge");
  });

  test("交互终端默认不选 request，并支持一次选择多个", async () => {
    const scenario = {
      schema: "doctor-http/v1" as const,
      name: "example",
      requests: [
        { id: "chat", entrypoints: [], compare: { body: "none" as const, sseEvents: true } },
        { id: "judge", entrypoints: [], compare: { body: "none" as const, sseEvents: true } },
      ],
    };
    const selected = await resolveHttpScenarioRequests(scenario, {
      interactive: true,
      prompt: async ({ choices, defaults, candidateType, context }) => {
        expect(choices.map((choice) => choice.name)).toEqual(["chat", "judge"]);
        expect(defaults).toEqual([]);
        expect(candidateType).toBe("Request");
        expect(context.purpose).toBe("确定本次要执行的 HTTP 场景请求");
        return ["chat", "judge"];
      },
    });
    expect(selected?.requests.map((request) => request.id)).toEqual(["chat", "judge"]);
  });

  test("只发现当前目录中符合 doctor-http/v1 schema 的 YAML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-discovery-"));
    writeFileSync(join(dir, "valid.yaml"), `schema: doctor-http/v1
requests:
  - id: health
    url: https://example.test/health
`);
    writeFileSync(join(dir, "also-valid.yml"), `schema: doctor-http/v1
requests:
  - id: health
    url: https://example.test/ready
`);
    writeFileSync(join(dir, "other.yaml"), "name: unrelated\n");
    writeFileSync(join(dir, "notes.txt"), "schema: doctor-http/v1\n");

    expect(findHttpScenarioFiles(dir)).toEqual(["also-valid.yml", "valid.yaml"]);
    expect(await resolveHttpScenarioFile({
      directory: dir,
      interactive: true,
      prompt: async (files) => files[1],
    })).toBe(join(dir, "valid.yaml"));
  });

  test("当前目录只有一个场景时直接使用并打印文件名", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-single-discovery-"));
    writeFileSync(join(dir, "only.yaml"), `schema: doctor-http/v1
requests:
  - id: health
    url: https://example.test/health
`);
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await resolveHttpScenarioFile({
        directory: dir,
        interactive: true,
        prompt: async () => { throw new Error("单个场景不应进入选择"); },
      })).toBe(join(dir, "only.yaml"));
      expect(write).toHaveBeenCalledWith("[http] HTTP 场景：only.yaml（当前目录唯一候选，自动选择）\n");
    } finally {
      write.mockRestore();
    }
  });

  test("非交互环境未指定 YAML 时给出 --file 与 --example 指引", async () => {
    expect(resolveHttpScenarioFile({ interactive: false })).rejects.toThrow("缺少 --file");
    expect(resolveHttpScenarioFile({ interactive: false })).rejects.toThrow("--example");
  });
});

describe("captureHttpResponse", () => {
  test("流式保存 header/body 并建立 SSE observation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-capture-"));
    const capture = await captureHttpResponse(request(), 2, dir, "attempts/round-002/chat", async () => response(
      200,
      "text/event-stream; charset=utf-8",
      'data: {"event":"start"}\n\n',
      'data: {"event":"end"}\n\n',
    ));

    expect(capture.response).toMatchObject({
      requestId: "chat",
      round: 2,
      captureComplete: true,
      statusCode: 200,
      bodyBytes: 48,
      terminationReason: "response_complete",
    });
    expect(readFileSync(join(dir, "headers.txt"), "utf-8")).toContain("x-request-id: request-1");
    expect(readFileSync(join(dir, "body.sse"), "utf-8")).toContain('"event":"end"');
    expect(capture.sse?.frames.map((frame) => frame.event)).toEqual(["start", "end"]);
    expect(detectHttpAttempt(request(), capture.response, capture.sse)).toEqual([]);
  });

  test("容量截断与请求异常仍返回可聚合结果", async () => {
    const sizeDir = mkdtempSync(join(tmpdir(), "doctor-http-size-"));
    const limited = await captureHttpResponse(
      request({ maxResponseBytes: 5, expect: { status: [200] } }),
      1,
      sizeDir,
      "attempts/round-001/chat",
      async () => response(200, "text/plain", "123456"),
    );
    expect(limited.response).toMatchObject({
      captureComplete: false,
      bodyBytes: 5,
      terminationReason: "size_limit",
    });
    expect(readFileSync(join(sizeDir, "body.txt"), "utf-8")).toBe("12345");

    const errorDir = mkdtempSync(join(tmpdir(), "doctor-http-error-"));
    const failed = await captureHttpResponse(request(), 1, errorDir, "attempts/round-001/chat", async () => {
      throw new Error("connection refused");
    });
    expect(failed.response).toMatchObject({
      captureComplete: false,
      statusCode: undefined,
      terminationReason: "request_error",
      error: "connection refused",
    });
    expect(existsSync(join(errorDir, "error.txt"))).toBe(true);
  });

  test("AbortController 将请求超时记录为 doctor_timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-http-timeout-"));
    const capture = await captureHttpResponse(
      request({ timeoutMs: 5 }),
      1,
      dir,
      "attempts/round-001/chat",
      async (_request, signal) => await new Promise<HttpTransportResponse>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    expect(capture.response).toMatchObject({
      captureComplete: false,
      terminationReason: "doctor_timeout",
    });
  });

  test("Got 连接失败时保留失败阶段 timings", async () => {
    const unavailable = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("unused"),
    });
    const url = `http://127.0.0.1:${unavailable.port}/health`;
    unavailable.stop(true);

    const dir = mkdtempSync(join(tmpdir(), "doctor-http-got-error-"));
    const capture = await captureHttpResponse(
      request({ url }),
      1,
      dir,
      "attempts/round-001/chat",
    );
    expect(capture.response).toMatchObject({
      captureComplete: false,
      terminationReason: "request_error",
      transport: {
        engine: "got",
        remoteAddress: "127.0.0.1",
        finalUrl: url,
        retryCount: 0,
      },
    });
    expect(capture.response.transport?.timings.totalMs).toBeNumber();
  });
});

test("Got transport 允许 entrypoint 覆盖 Host header，并记录连接诊断", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(incoming) {
      if (new URL(incoming.url).pathname === "/redirect") {
        return Response.redirect(new URL("/health", incoming.url).toString(), 302);
      }
      return Response.json({ host: incoming.headers.get("host") });
    },
  });
  try {
    const result = await sendHttpRequest({
      url: `http://127.0.0.1:${server.port}/health`,
      method: "GET",
      headers: { Host: "frontend.example.test" },
      followRedirects: true,
    }, new AbortController().signal);
    expect(await new Response(result.body).json()).toEqual({ host: "frontend.example.test" });
    expect(result.diagnostics).toMatchObject({
      engine: "got",
      remoteAddress: "127.0.0.1",
      finalUrl: `http://127.0.0.1:${server.port}/health`,
      redirectUrls: [],
      retryCount: 0,
      timings: {
        dnsMs: 0,
      },
    });
    expect(result.diagnostics?.timings.totalMs).toBeNumber();

    const redirected = await sendHttpRequest({
      url: `http://127.0.0.1:${server.port}/redirect`,
      method: "GET",
      headers: {},
      followRedirects: true,
    }, new AbortController().signal);
    expect(await new Response(redirected.body).json()).toEqual({ host: `127.0.0.1:${server.port}` });
    expect(redirected.diagnostics).toMatchObject({
      finalUrl: `http://127.0.0.1:${server.port}/health`,
      redirectUrls: [`http://127.0.0.1:${server.port}/health`],
    });
  } finally {
    server.stop(true);
  }
});

test("按最终 request plan 生成可复现 cURL", () => {
  const curl = renderHttpRequestAsCurl(request({
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer actual-token",
    },
    body: encoder.encode('{"query":"hello"}'),
    timeoutMs: 2500,
  }));

  expect(curl).toContain("--location");
  expect(curl).toContain("--request 'POST'");
  expect(curl).toContain("--max-time '2.5'");
  expect(curl).toContain("--header 'Authorization: Bearer actual-token'");
  expect(curl).toContain("--data-binary '{\"query\":\"hello\"}'");
  expect(curl).toContain("'https://example.test/chats'");
});

test("HTTP Inspect 按规范化 host:port 去重，并保留受影响 request 引用", () => {
  const scenario = {
    schema: "doctor-http/v1" as const,
    name: "deduplicate-endpoints",
    requests: [{
      id: "chat",
      compare: { body: "none" as const, sseEvents: true },
      entrypoints: [
        request({ requestId: "chat", entrypointId: "outer", url: "https://API.EXAMPLE.test/a" }),
        request({ requestId: "chat", entrypointId: "inner", url: "https://api.example.test:443/b" }),
      ],
    }],
  };

  const endpoints = resolveHttpScenarioEndpoints(scenario);
  expect(endpoints).toHaveLength(1);
  expect(endpoints[0]?.endpoint).toMatchObject({
    key: "api.example.test:443",
    host: "api.example.test",
    port: 443,
  });
  expect(endpoints[0]?.references.map((reference) => reference.entrypointId)).toEqual([
    "outer",
    "inner",
  ]);
});

test("detector 识别状态、耗时、SSE 终态和 error event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-detect-"));
  const plan = request({ expect: { status: [201], maxDurationMs: 0.1, sseTerminalEvent: "end" } });
  const capture = await captureHttpResponse(plan, 1, dir, "attempts/round-001/chat", async () => response(
    500,
    "text/event-stream",
    'data: {"event":"error","code":"E1","trace_id":"trace-1"}\n\n',
  ));
  const findings = detectHttpAttempt(plan, { ...capture.response, durationMs: 10 }, capture.sse);
  expect(findings.map((finding) => finding.kind)).toContain("http.unexpected-status");
  expect(findings.map((finding) => finding.kind)).toContain("http.response-too-slow");
  expect(findings.map((finding) => finding.kind)).toContain("http.sse-missing-terminal-event");
  expect(findings).toContainEqual(expect.objectContaining({ kind: "http.sse-error-event", code: "E1" }));
});

test("跨轮汇总识别偶现失败并计算延迟分位数", () => {
  const execution = (round: number, requestSuccess: boolean, durationMs: number): HttpExecution => ({
    requestId: "chat",
    entrypointId: "default",
    round,
    directory: `attempts/${round}`,
    response: {
      id: `response-${round}`,
      kind: "http-response",
      requestId: "chat",
      entrypointId: "default",
      round,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(durationMs).toISOString(),
      durationMs,
      captureComplete: true,
      statusCode: requestSuccess ? 200 : 500,
      bodyBytes: 0,
      bodySha256: "empty",
      headersFile: "headers.txt",
      bodyFile: "body.bin",
      terminationReason: "response_complete",
    },
    findings: requestSuccess ? [] : [{
      id: `status-${round}`,
      kind: "http.unexpected-status",
      severity: "critical",
      confidence: "high",
      evidence: [{ observationId: `response-${round}`, role: "supporting" }],
      requestId: "chat",
      entrypointId: "default",
      round,
      actual: 500,
      expected: [200],
    }],
    requestSuccess,
  });
  const group: HttpRequestGroup = {
    id: "chat",
    entrypoints: [request()],
    compare: { body: "none", sseEvents: true },
  };
  const diagnosis = diagnoseHttp([
    execution(1, true, 10),
    execution(2, false, 30),
    execution(3, true, 20),
  ], [group]);
  expect(diagnosis.findings).toContainEqual(expect.objectContaining({
    kind: "http.intermittent-failure",
    successful: 2,
    failed: 1,
  }));
  expect(diagnosis.summaries[0]).toMatchObject({ durationMinMs: 10, durationP50Ms: 20, durationP95Ms: 30 });
});

test("runCollectHttp 完成全部轮次后输出偶现失败报告", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-run-"));
  const file = join(dir, "requests.yaml");
  const output = join(dir, "report");
  writeFileSync(file, `schema: doctor-http/v1
requests:
  - id: health
    url: https://example.test/health
`);
  let call = 0;
  const code = await runCollectHttp({
    file,
    repeat: "2",
    interval: "0",
    format: "html",
    output,
  }, createCommandContext(), async () => {
    call += 1;
    return response(call === 1 ? 200 : 500, "application/json", "{}");
  }, reachableEndpoint);

  expect(code).toBe(0);
  expect(call).toBe(2);
  const html = readFileSync(`${output}.html`, "utf-8");
  expect(html).toContain("doctor http 诊断报告");
  expect(html).toContain("执行位置：local");
  expect(html).toContain("存在偶现失败");
  expect(html).toContain("执行次数：2");
  expect(html).toContain("实际请求 cURL");
  expect(html).toContain("language-bash");
  expect(html).toContain("异常 Response");
  expect(html).toContain("HTTP 500 Internal Server Error");
});

test("runCollectHttp 只执行 --request 指定的请求", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-request-filter-"));
  const file = join(dir, "requests.yaml");
  const output = join(dir, "report");
  writeFileSync(file, `schema: doctor-http/v1
requests:
  - id: chat
    url: https://example.test/chat
  - id: judge
    url: https://example.test/v1/judge
`);
  const requestedUrls: string[] = [];
  const code = await runCollectHttp({
    file,
    request: "judge",
    repeat: "1",
    interval: "0",
    format: "html",
    output,
  }, createCommandContext(), async (plan) => {
    requestedUrls.push(plan.url);
    return response(200, "application/json", "{}");
  }, reachableEndpoint);

  expect(code).toBe(0);
  expect(requestedUrls).toEqual(["https://example.test/v1/judge"]);
});

test("同轮按 entrypoint 顺序对比响应，定位首次出现差异的区间", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-compare-"));
  const file = join(dir, "requests.yaml");
  const output = join(dir, "report");
  writeFileSync(file, `schema: doctor-http/v1
requests:
  - id: chat
    method: POST
    url: https://platform.test/chats
    json:
      query: hello
    entrypoints:
      - id: edge-gateway
      - id: proxy
        url: https://proxy.test/chats
      - id: frontend
        url: http://10.0.0.8:8000/chats
    compare:
      body: exact
`);
  let call = 0;
  const code = await runCollectHttp({
    file,
    repeat: "1",
    interval: "0",
    format: "html",
    output,
  }, createCommandContext(), async () => {
    call += 1;
    return call === 1
      ? response(500, "application/json", '{"error":"proxy failed"}')
      : response(200, "application/json", '{"ok":true}');
  }, reachableEndpoint);

  expect(code).toBe(0);
  expect(call).toBe(3);
  const html = readFileSync(`${output}.html`, "utf-8");
  expect(html).toContain("从 edge-gateway 到 proxy 开始出现响应差异");
  expect(html).not.toContain("从 proxy 到 frontend 开始出现响应差异");
});

test("Inspect 判定 host:port 不可达时跳过真实 HTTP Probe 并报告 Fact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-unreachable-"));
  const file = join(dir, "requests.yaml");
  const output = join(dir, "report");
  writeFileSync(file, `schema: doctor-http/v1
requests:
  - id: health
    url: http://missing.example.test:8080/health
`);
  let calls = 0;
  const code = await runCollectHttp({
    file,
    repeat: "1",
    interval: "0",
    format: "html",
    output,
  }, createCommandContext(), async () => {
    calls += 1;
    return response(200, "application/json", "{}");
  }, async () => ({
    reachable: false,
    phase: "dns",
    resolvedAddresses: [],
    durationMs: 2,
    reason: "ENOTFOUND missing.example.test",
  }));

  expect(code).toBe(1);
  expect(calls).toBe(0);
  const html = readFileSync(`${output}.html`, "utf-8");
  expect(html).toContain("missing.example.test:8080");
  expect(html).toContain("DNS 阶段不可达");
  expect(html).toContain("HTTP response observations: 0/1");
});

test("显式 Bundle 同时交付离线报告与每次原始响应", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-bundle-"));
  const file = join(dir, "requests.yaml");
  const output = join(dir, "capture");
  writeFileSync(file, `schema: doctor-http/v1
requests:
  - id: health
    url: https://example.test/health
`);
  const code = await runCollectHttp({
    file,
    repeat: "1",
    interval: "0",
    format: "bundle",
    output,
  }, createCommandContext(), async () => response(200, "application/json", "{}"), reachableEndpoint);

  expect(code).toBe(0);
  const archive = `${output}.tar.gz`;
  expect(existsSync(archive)).toBe(true);
  const listing = Bun.spawnSync(["tar", "-tzf", archive]).stdout.toString();
  expect(listing).toContain("/report.html");
  expect(listing).toContain("/attempts/round-001/health/default/headers.txt");
  expect(listing).toContain("/attempts/round-001/health/default/body.json");
  expect(listing).toContain("/attempts/round-001/health/default/meta.json");
  const manifestEntry = listing.split(/\r?\n/).find((entry) => entry.endsWith("/manifest.json"));
  expect(manifestEntry).toBeDefined();
  const manifest = JSON.parse(Bun.spawnSync([
    "tar", "-xOzf", archive, manifestEntry!,
  ]).stdout.toString()) as {
    inspection_facts: { endpoints: { status: string; items: unknown[] } };
    steps: Array<{ id: string; status: string }>;
  };
  expect(manifest.inspection_facts.endpoints).toMatchObject({ status: "collected" });
  expect(manifest.inspection_facts.endpoints.items).toHaveLength(1);
  expect(manifest.steps).toContainEqual(expect.objectContaining({
    id: "http-endpoint-connectivity",
    status: "ok",
  }));
});

test("Markdown format 交付实际 cURL 与异常 Response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-http-markdown-"));
  const file = join(dir, "requests.yaml");
  const output = join(dir, "report");
  writeFileSync(file, `schema: doctor-http/v1
requests:
  - id: health
    url: https://example.test/health
`);
  const code = await runCollectHttp({
    file,
    repeat: "1",
    interval: "0",
    format: "md",
    output,
  }, createCommandContext(), async () => response(400, "application/json", '{"error":"invalid request"}'), reachableEndpoint);

  expect(code).toBe(0);
  const markdown = readFileSync(`${output}.md`, "utf-8");
  expect(markdown).toContain("# doctor http diagnosis");
  expect(markdown).toContain("- execution: local");
  expect(markdown).toContain("## 实际请求 cURL");
  expect(markdown).toContain("```bash\ncurl");
  expect(markdown).toContain("## 异常 Response");
  expect(markdown).toContain("HTTP 400 Bad Request");
  expect(markdown).toContain('{"error":"invalid request"}');
});

test("HTTP 默认双交付并保留显式格式", () => {
  expect(defaultHttpBundleName(new Date(2026, 6, 22, 15, 4, 5))).toBe("doctor-http-20260722-150405");
  expect(parseHttpOutputFormat(undefined)).toBe("default");
  expect(parseHttpOutputFormat("html")).toBe("html");
  expect(parseHttpOutputFormat("md")).toBe("md");
  expect(() => parseHttpOutputFormat("pdf")).toThrow("bundle、html 或 md");
  expect(resolveHttpOutputPath(undefined, "doctor-http-1", "bundle")).toBe("doctor-http-1.tar.gz");
  expect(resolveHttpOutputPath(undefined, "doctor-http-1", "html")).toBe("doctor-http-1.html");
  expect(resolveHttpOutputPath("report", "doctor-http-1", "html")).toBe("report.html");
  expect(resolveHttpOutputPath(undefined, "doctor-http-1", "md")).toBe("doctor-http-1.md");
  expect(resolveHttpOutputPath("report", "doctor-http-1", "md")).toBe("report.md");
  expect(() => resolveHttpOutputPath("report.html", "doctor-http-1", "md")).toThrow("输出路径");
});
