import { S3Error } from "@compforge/harness-toolbox/s3";
import { expect, test } from "bun:test";
import { checkS3ReadWrite, type S3HealthCheck, type S3ReadWriteClient } from "../src/health/s3/probe";
import { createServiceCatalog, type ServiceDefinition } from "@compforge/doctor-plugin";
import { healthProviders } from "../src/health/extensions";
import { runHealthSession } from "../src/health/flow";
import { buildHealthHtml } from "../src/health/report";

function fixture() {
  const calls: { operation: string; bucket: string; key: string; versionId?: string }[] = [];
  const controller = new AbortController();
  const result: S3HealthCheck = { service: "files", dataSource: "s3", endpoint: "http://s3.test", bucket: "bucket",
    executionLocation: "doctor-host", channel: "direct", startedAt: new Date().toISOString(), status: "unavailable", steps: [] };
  const client: S3ReadWriteClient = {
    putObject: async (bucket, key, bytes, options) => {
      calls.push({ operation: "put", bucket, key });
      expect(Buffer.from(bytes).toString()).toBe("hello world");
      expect(options.maxBytes).toBe(11);
      return { versionId: "v1", etag: "etag-1", response: { httpStatusCode: 200, requestId: "put-1", attempts: 1 } };
    },
    presignGetObject: async (bucket, key, options) => {
      calls.push({ operation: "presign", bucket, key, versionId: options.versionId });
      expect(options.expiresIn).toBe(60);
      return "http://s3.test/hello.txt?X-Amz-Signature=SECRET";
    },
    deleteObject: async (bucket, key, options) => {
      expect(options?.signal?.aborted).toBe(false);
      calls.push({ operation: "delete", bucket, key, versionId: options?.versionId });
    },
  };
  const input = { result, client, secrets: ["SECRET"], bucket: "bucket", prefix: "customer/prefix/", signal: controller.signal,
    approve: async () => ({ approved: true, source: "assume-yes" as const }), checkpoint: () => {},
    download: async (url: string, _signal: AbortSignal) => {
      expect(url).toContain("X-Amz-Signature=SECRET");
      calls.push({ operation: "get", bucket: "bucket", key: result.key!, versionId: result.versionId });
      return { status: 200, headers: {} as Record<string, string>, body: Buffer.from("hello world") };
    } };
  return { calls, controller, result, client, input };
}

test("S3 checks only a unique hello.txt key under the configured prefix and cleans the exact uploaded version", async () => {
  const a = fixture(); const b = fixture();
  await checkS3ReadWrite(a.input); await checkS3ReadWrite(b.input);
  expect(a.result.key).toMatch(/^customer\/prefix\/doctor-health\/[a-f0-9-]+\/hello.txt$/);
  expect(a.result.key).not.toBe(b.result.key);
  expect(a.result.status).toBe("passed");
  expect(a.result.steps.map(step => step.status)).toEqual(["passed", "passed", "passed", "passed"]);
  expect(a.calls.map(call => call.operation)).toEqual(["put", "presign", "get", "delete"]);
  expect(new Set(a.calls.map(call => call.key))).toEqual(new Set([a.result.key!]));
  expect(a.calls.slice(1).map(call => call.versionId)).toEqual(["v1", "v1", "v1"]);
  expect(a.result.steps[2]!.bytes).toBe(11);
  expect(a.result.steps[0]!.response).toMatchObject({ httpStatus: 200, requestId: "put-1", etag: "etag-1", versionId: "v1" });
  expect(a.result.steps[2]!.response?.body).toBe("hello world");
});

for (const bytes of ["hello world\n", "hello worlx", "", "login page"]) test(`download bytes are validated exactly: ${JSON.stringify(bytes)}`, async () => {
  const f = fixture();
  f.input.download = async () => ({ status: 200, headers: {}, body: Buffer.from(bytes) });
  await checkS3ReadWrite(f.input);
  expect(f.result.status).toBe("failed");
  expect(f.result.steps[2]!.reason).toContain("不一致");
  expect(f.result.steps[3]!.status).toBe("passed");
});

test("PUT denial prevents GET and cleanup; SDK facts omit echoed signed URLs", async () => {
  const f = fixture();
  f.client.putObject = async () => { throw Object.assign(new Error("https://s3/?token=SECRET"), { name: "AccessDenied", $metadata: { httpStatusCode: 403, requestId: "r1" } }); };
  await checkS3ReadWrite(f.input);
  expect(f.result.status).toBe("failed");
  expect(f.result.steps.map(step => step.status)).toEqual(["failed", "not-run", "not-run", "not-run"]);
  expect(f.result.steps[0]!.failure).toMatchObject({ code: "AccessDenied", httpStatus: 403, requestId: "r1" });
  expect(JSON.stringify(f.result)).not.toContain("SECRET");
  expect(f.calls).toEqual([]);
});

test("failed or cancelled downloads still clean up using a live cleanup deadline", async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    f.input.download = async () => { if (cancel) f.controller.abort(); throw Object.assign(new Error("failure"), { name: cancel ? "AbortError" : "NoSuchKey" }); };
    await checkS3ReadWrite(f.input);
    expect(f.result.status).toBe(cancel ? "cancelled" : "failed");
    expect(f.result.steps[3]!.status).toBe("passed");
    expect(f.calls.map(call => call.operation)).toEqual(["put", "presign", "delete"]);
  }
});

test("cleanup denial retains successful read/write results and the exact residual object identity", async () => {
  const f = fixture();
  f.client.deleteObject = async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); };
  await checkS3ReadWrite(f.input);
  expect(f.result.status).toBe("failed");
  expect(f.result.steps.map(step => step.status)).toEqual(["passed", "passed", "passed", "failed"]);
  expect(f.result.reason).toContain("清理失败");
  expect(f.result.versionId).toBe("v1");
});

test("approval denial and cancellation before execution never touch S3", async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    if (cancel) f.controller.abort();
    await checkS3ReadWrite({ ...f.input, approve: async request => {
      expect(request.target).toContain("Doctor host");
      expect(request.target).toContain(f.result.key!);
      return { approved: false, source: "prompt" };
    } });
    expect(f.result.status).toBe(cancel ? "cancelled" : "skipped");
    expect(f.calls).toEqual([]);
  }
});

for (const [source, reason] of [
  ["prompt", "用户未确认"], ["non-interactive", "非交互终端无法取得确认（可用 -y/--yes 预先批准）"], ["gate-error", "确认环节出错"],
] as const) test(`S3 approval denial preserves ${source} reason without accessing storage`, async () => {
  const f = fixture();
  await checkS3ReadWrite({ ...f.input, approve: async () => ({ approved: false, source }) });
  expect(f.result.status).toBe(source === "prompt" ? "skipped" : "not-run");
  expect(f.result.reason).toBe(source === "prompt" ? "用户跳过 S3 读写检查" : `${reason}，已取消该操作`);
  expect(f.result.steps.every(step => step.status === "not-run")).toBe(true);
  expect(f.calls).toEqual([]);
});

const service: ServiceDefinition = { name: "files", component: { name: "files", repository: { forge: { name: "test" }, path: "files" } }, workloads: [],
  dataSources: [{ id: "s3", kind: "s3", backend: "s3-compatible", environment: { endpoint: "ENDPOINT", bucket: "BUCKET", region: "REGION", accessKey: "AK", secretKey: "SK" } }] };
const plugin = { id: "test", version: "1", services: createServiceCatalog([service]) };

test("S3-only Service participates in deps and renders upload/download/cleanup evidence", async () => {
  const providers = healthProviders(plugin, ["files"]);
  expect(providers[0]!.s3Sources).toEqual([{ service: "files", dataSource: "s3" }]);
  const f = fixture();
  const result = await runHealthSession(providers, {}, { scopes: ["deps"], show: () => {},
    cases: async () => { throw new Error("no HTTP Cases"); },
    s3: async (_provider, checkpoint) => { await checkS3ReadWrite(f.input); checkpoint([f.result]); return [f.result]; },
  });
  expect(result.providers[0]!.s3?.[0]!.status).toBe("passed");
  const html = buildHealthHtml(result);
  expect(html).toContain("S3 读写检查"); expect(html).toContain("Doctor host"); expect(html).toContain("下载并校验内容");
});

test("skipped S3 scope has explicit not-run evidence without preparing a client", async () => {
  const result = await runHealthSession(healthProviders(plugin, ["files"]), {}, { scopes: ["deps"], show: () => {},
    enterScope: async () => false, cases: async () => [], s3: async () => { throw new Error("not run"); },
  });
  expect(result.providers[0]!.s3?.[0]!.status).toBe("not-run");
});

test("runtime resolves Service configuration and performs signed S3 traffic directly from Host", async () => {
  const { S3HealthSession } = await import("../src/health/s3/runtime");
  const { CommandContext } = await import("../src/command");
  const { healthCommand } = await import("../src/health");
  const { CommandStatus } = await import("../src/command");
  const { writeHealthEvidence } = await import("../src/health/report");
  const { finalizeResult, readReport } = await import("./report-fixture");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const calls: string[] = [];
  let content = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    calls.push(request.method);
    const query = new URL(request.url).searchParams;
    const date = (request.method === "GET" ? query.get("X-Amz-Date") : request.headers.get("x-amz-date"))!;
    expect(date).toMatch(/^\d{8}T\d{6}Z$/);
    const credential = `fixture-ak/${date.slice(0, 8)}/region-1/s3/aws4_request`;
    if (request.method === "GET") {
      expect(request.headers.get("authorization")).toBeNull();
      expect(query.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(query.get("X-Amz-Expires")).toBe("60");
      expect(query.get("X-Amz-Credential")).toBe(credential);
      expect(query.get("X-Amz-Security-Token")).toBe("SESSION-TOKEN");
    } else {
      expect(request.headers.get("authorization")).toStartWith(`AWS4-HMAC-SHA256 Credential=${credential},`);
      expect(request.headers.get("x-amz-security-token")).toBe("SESSION-TOKEN");
    }
    expect(new URL(request.url).pathname).toMatch(/^\/bucket\/prefix\/doctor-health\/[^/]+\/hello.txt$/);
    if (request.method === "PUT") { content = await request.text(); return new Response(null, { headers: { "x-amz-version-id": "test-version" } }); }
    expect(new URL(request.url).searchParams.get("versionId")).toBe("test-version");
    if (request.method === "GET") return new Response(content);
    return new Response(null, { status: 204 });
  } });
  const target = { endpoint: `http://127.0.0.1:${server.port}`, bucket: "bucket", bucketPrefix: "prefix", region: "region-1",
    credentials: { accessKeyId: "fixture-ak", secretAccessKey: "SECRET-KEY", sessionToken: "SESSION-TOKEN" }, forcePathStyle: true };
  const sourceService: ServiceDefinition = { ...service, dataSources: [{ id: "s3", kind: "s3", backend: "s3-compatible",
    source: { clientKey: "s3-health-fixture", createClient: () => ({ target, access: {} as never, initialize: async () => {}, dispose: async () => {} }) } }] };
  const selected = { ...plugin, services: createServiceCatalog([sourceService]) };
  const context = new CommandContext({}, undefined, { yes: true, plugin: selected });
  const executor: import("@compforge/harness-toolbox/kubernetes/executor").Executor = {
    run: async command => {
      if (command[0] !== "config") throw new Error("Unexpected Kubernetes access: " + command.join(" "));
      return { command, ok: true, exitCode: 0, stdout: "cluster\nhttps://kubernetes.test", stderr: "", durationMs: 1, timedOut: false };
    }, exec: async () => { throw new Error("no Pod download"); },
  };
  const directory = mkdtempSync(join(tmpdir(), "health-s3-evidence-"));
  try {
    const checks = await new S3HealthSession(context,
      { kubernetes: { namespace: "ns" } } as import("../src/command/kubernetes-target").KubernetesCommandConfig, executor)
      .check(healthProviders(selected, ["files"])[0]!, () => {});
    expect(checks[0]!.status, checks[0]!.reason).toBe("passed");
    expect(checks[0]).toMatchObject({ region: "region-1", addressStyle: "path" });
    expect(calls).toEqual(["PUT", "GET", "DELETE"]);
    expect(content).toBe("hello world");
    for (const secret of ["fixture-ak", "SECRET-KEY", "SESSION-TOKEN"]) expect(JSON.stringify(checks)).not.toContain(secret);
    const output = { query: {}, providers: [{ name: "files", namespace: "ns", s3: checks }] };
    writeHealthEvidence(output, context, mkdtempSync(join(directory, "source-")));
    const delivery = join(directory, "result.html");
    expect(await finalizeResult(context, healthCommand, { status: CommandStatus.Ok, output, artifacts: context.artifacts.list() }, { format: "html", output: delivery })).toBe(0);
    const report = readReport(readFileSync(delivery, "utf8"));
    expect(report.pages).toContain("S3 读写检查");
    expect(report.pages).toContain("Doctor host");
    for (const secret of ["fixture-ak", "SECRET-KEY", "SESSION-TOKEN"]) expect(report.pages).not.toContain(secret);
    expect(report.pages).not.toContain("X-Amz-Signature");
  } finally { server.stop(true); await context.disposeClients(); rmSync(directory, { recursive: true, force: true }); }
});

for (const status of [403, 302]) test(`presigned HTTP ${status} fails download and still removes the uploaded version`, async () => {
  const f = fixture();
  f.input.download = async () => ({ status, headers: { "x-amz-request-id": "request-1" },
    body: Buffer.from("<Error><Code>SignatureDoesNotMatch</Code><Message>SECRET URL</Message></Error>") });
  await checkS3ReadWrite(f.input);
  expect(f.result.status).toBe("failed");
  expect(f.result.steps[2]!.failure).toMatchObject({ httpStatus: status, code: "SignatureDoesNotMatch", requestId: "request-1" });
  expect(f.result.steps[3]!.status).toBe("passed");
  expect(JSON.stringify(f.result)).not.toContain("SECRET");
});

test("presign failure is separate from download and still cleans up the upload", async () => {
  const f = fixture();
  f.client.presignGetObject = async () => { throw new Error("failed signing SECRET"); };
  await checkS3ReadWrite(f.input);
  expect(f.result.steps.map(step => step.status)).toEqual(["passed", "failed", "not-run", "passed"]);
  expect(f.calls.map(call => call.operation)).toEqual(["put", "delete"]);
  expect(JSON.stringify(f.result)).not.toContain("SECRET");
});

for (const status of [301, 307]) test(`S3 HTTP ${status} evidence retains Location but redacts signing parameters`, async () => {
  const { captureS3HttpResponse } = await import("../src/health/s3/response");
  const response = captureS3HttpResponse({ status, headers: {
    location: "https://store/key?X-Amz-Signature=signature-secret&X-Amz-Credential=access-secret&X-Amz-Security-Token=session-secret",
  }, body: Buffer.from("") }, []);
  expect(response.httpStatus).toBe(status);
  const location = new URL(response.headers!.location!);
  expect(location.origin + location.pathname).toBe("https://store/key");
  for (const parameter of ["X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token"]) {
    expect(location.searchParams.get(parameter)).toBe("[redacted]");
  }
  for (const secret of ["signature-secret", "access-secret", "session-secret"]) expect(JSON.stringify(response)).not.toContain(secret);
});

test("S3 response evidence retains diagnostics and removes credentials before truncation", async () => {
  const { captureS3HttpResponse, captureS3ErrorResponse } = await import("../src/health/s3/response");
  const body = '<Error><Code>SignatureDoesNotMatch</Code><Message>wrong region</Message><Region>eu-west-1</Region>'
    + '<CanonicalRequest>GET /private key</CanonicalRequest><AWSAccessKeyId>access-secret</AWSAccessKeyId>'
    + '<SignatureProvided>signature-secret</SignatureProvided><StringToSignBytes>binary-secret</StringToSignBytes>'
    + '<Resource>https://store/key?X-Amz-Signature=signature-secret&amp;X-Amz-Credential=access-secret</Resource></Error>';
  const response = captureS3HttpResponse({ status: 403, headers: { "x-amz-request-id": "req-1", "x-amz-id-2": "host-1",
    "x-amz-bucket-region": "eu-west-1", "set-cookie": "session-secret", "content-type": "application/xml" }, body: Buffer.from(body) },
    ["access-secret", "signature-secret"]);
  expect(response).toMatchObject({ httpStatus: 403, requestId: "req-1", extendedRequestId: "host-1",
    headers: { "x-amz-bucket-region": "eu-west-1" }, bodyTruncated: false });
  expect(response.headers).not.toHaveProperty("set-cookie");
  expect(response.body).toContain("SignatureDoesNotMatch"); expect(response.body).toContain("wrong region");
  for (const secret of ["access-secret", "signature-secret", "binary-secret", "session-secret", "GET /private key"]) {
    expect(JSON.stringify(response)).not.toContain(secret);
  }
  expect(captureS3HttpResponse({ status: 500, headers: {}, body: Buffer.from("x".repeat(5000)) }, [])).toMatchObject({ bodyTruncated: true });
  const sdk = captureS3ErrorResponse(S3Error.from(Object.assign(new Error("Invalid access-secret credentials"), {
    name: "AccessDenied", Region: "eu-west-1", $metadata: { httpStatusCode: 403, requestId: "put-1", extendedRequestId: "put-host", attempts: 1 },
    $response: { headers: { "x-amz-bucket-region": "eu-west-1" } },
  })), ["access-secret"]);
  expect(sdk).toMatchObject({ httpStatus: 403, requestId: "put-1", extendedRequestId: "put-host", attempts: 1 });
  expect(sdk?.body).toContain("Invalid [redacted] credentials");
});

test("network failures use the shared connectivity probe without replacing S3 evidence", async () => {
  const { supplementS3Connectivity } = await import("../src/health/s3/connectivity");
  const f = fixture();
  f.client.putObject = async () => { throw Object.assign(new Error("dns"), { code: "ENOTFOUND" }); };
  await checkS3ReadWrite(f.input);
  let calls = 0;
  const target = { endpoint: "https://store.test", region: "r1", ca: "custom CA",
    credentials: { accessKeyId: "ak", secretAccessKey: "sk" } };
  await supplementS3Connectivity(f.result, target, f.controller.signal, async (argv, options) => {
    calls++; expect(argv[0]).toBe("python3"); expect(options.timeoutMs).toBe(5000);
    expect(JSON.parse(options.stdin)).toMatchObject({ host: "store.test", port: 443 });
    expect(JSON.parse(options.stdin).tls).toBeUndefined();
    return JSON.stringify({ status: "failed", stages: [{ stage: "dns", status: "failed", elapsedMs: 1, error: "gaierror" }] });
  });
  expect(f.result.status).toBe("failed"); expect(f.result.steps[0]!.failure?.code).toBe("ENOTFOUND");
  expect(f.result.connectivity?.status).toBe("failed"); expect(calls).toBe(1);
  f.result.steps[0]!.failure = new S3Error({ code: "AccessDenied", httpStatus: 403 }).toJSON();
  await supplementS3Connectivity(f.result, target, f.controller.signal, async () => { throw new Error("unexpected probe"); });
  expect(f.result.connectivity?.status).toBe("failed");
});

test("biz scope does not prepare or execute Host S3 checks", async () => {
  const result = await runHealthSession(healthProviders(plugin), {}, { scopes: ["business"], show: () => {},
    cases: async () => { throw new Error("no business consumers"); },
    s3: async () => { throw new Error("Host S3 belongs to deps"); },
  });
  expect(result.providers[0]?.s3).toBeUndefined();
});
