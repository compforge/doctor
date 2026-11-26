import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServiceCatalog, kubernetesServiceWorkload, s3DataSource } from "@compforge/doctor-plugin";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { createDoctorProgram } from "../src/app/main";
import { expect, spyOn, test } from "bun:test";
import { crc32 } from "node:zlib";
import { DirectTransport, PortForwardTransport } from "@compforge/harness-toolbox/transport";
import { HttpClient } from "@compforge/harness-toolbox/http";
import { probeChunkLimit, S3Wire } from "../src/collect/s3/chunk";
import { inspectS3, prepareInspection } from "../src/collect/s3/inspect";
import { resolveS3Request } from "../src/collect/s3/input";
import { startS3Fixture } from "./s3-fixture";

test("inspect verifies the wire frame and cleans the returned version at the exact 16 MiB boundary", async () => {
  const sizes: number[] = [], deleted: string[] = [];
  const objects = new Map<string, number>();
  const fixture = await startS3Fixture(async (url, request) => {
    const path = new URL(url);
    if (path.searchParams.has("versioning")) return new Response("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
    if (request.method === "HEAD") {
      if (path.pathname === "/bucket") return new Response(null, { headers: { "x-amz-bucket-region": "test-region", server: "test-store" } });
      if (path.pathname === "/bucket/business") return new Response(null, { headers: { "content-length": "37" } });
      return new Response(null, { headers: { "content-length": String(objects.get(path.pathname)) } });
    }
    expect(path.pathname).toMatch(/^\/bucket\/doctor-probe\/[0-9a-f-]+$/);
    if (request.method === "DELETE") {
      expect(path.searchParams.get("versionId")).toBe("test-version");
      objects.delete(path.pathname);
      deleted.push(path.pathname);
      return new Response(null, { status: 204 });
    }
    expect(request.method).toBe("PUT");
    expect(request.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(request.headers.get("content-encoding")).toBe("aws-chunked");
    expect(request.headers.get("x-amz-content-sha256")).toBe("STREAMING-UNSIGNED-PAYLOAD-TRAILER");
    const body = Buffer.from(await request.arrayBuffer());
    expect(Number(request.headers.get("content-length"))).toBe(body.length);
    const start = body.indexOf("\r\n") + 2;
    const size = parseInt(body.subarray(0, start - 2).toString(), 16);
    expect(Number(request.headers.get("x-amz-decoded-content-length"))).toBe(size);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body.subarray(start, start + size)));
    expect(body.subarray(start + size).toString()).toBe("\r\n0\r\nx-amz-checksum-crc32:" + checksum.toString("base64") + "\r\n\r\n");
    sizes.push(size);
    if (size > 16 * 1024 ** 2) return new Response("<Error><Code>BadRequest</Code><Message>chunk too big: choose chunk size &lt;= 16MiB</Message></Error>",
      { status: 400, headers: { "x-amz-request-id": "rejected-frame" } });
    objects.set(path.pathname, size);
    return new Response(null, { headers: { "x-amz-version-id": "test-version", "x-amz-request-id": "frame-" + size } });
  });
  const http = new HttpClient(fixture.target, new DirectTransport(), { concurrency: 1, connectTimeoutMs: 1000, requestTimeoutMs: 5000, maxResponseBytes: 8192 });
  const wire = new S3Wire(http, new URL("/bucket/", fixture.target.endpoint), fixture.target);
  try {
    const request = resolveS3Request({ action: "inspect", path: "svc/bucket/business" });
    const result = await inspectS3(fixture.client, request, fixture.client.signal,
      await prepareInspection("bucket", request.timeoutMs, async () => wire), async () => ({ approved: true }));
    expect(result).toMatchObject({ errors: {}, bucketHead: { httpStatus: 200, region: "test-region", server: "test-store" },
      object: { size: 37 }, versioning: "enabled", chunk: { maxChunkBytes: 16777216, stoppedReason: "exact" } });
    expect(result.chunk?.samples.at(-1)?.requestId).toBe("rejected-frame");
    expect(sizes).toEqual([16777216, 16777217]);
    expect(deleted).toHaveLength(1);
    expect(objects.size).toBe(0);
  } finally { await http.dispose(); await fixture.close(); }
});

test("bare inspect defers the bucket to service configuration", () => {
  expect(resolveS3Request({ action: "inspect" })).toMatchObject({ action: "inspect", bucket: undefined, timeoutMs: 90000 });
});

test.each([
  ["one source", undefined, true],
  ["interruption during client creation", "prepare-interrupt", false],
  ["interruption after PUT", "interrupt", true],
  ["equivalent sources", "same", true],
  ["different default buckets", "bucket", false],
  ["different default buckets with an explicit bucket", "override", true],
  ["different credentials", "credentials", false],
  ["the same short hostname in different namespaces", "namespace", false],
] as const)("inspect discovery with %s", async (_description, variant, canInspect) => {
  const root = mkdtempSync(join(tmpdir(), "s3-inspect-cli-"));
  const previous = process.cwd(), exitCode = process.exitCode;
  const methods: string[] = [];
  let probePath: string | undefined;
  const fixture = await startS3Fixture(async (url, request) => {
    if (variant === "interrupt") {
      const path = new URL(url);
      if (request.method === "PUT") {
        methods.push("PUT");
        await request.arrayBuffer();
        probePath = path.pathname;
        return new Response(null, { headers: { "x-amz-version-id": "fixture-v1" } });
      }
      if (request.method === "DELETE") {
        methods.push("DELETE");
        expect(path.pathname).toBe(probePath!);
        expect(path.searchParams.get("versionId")).toBe("fixture-v1");
        return new Response(null, { status: 204 });
      }
    }
    methods.push(request.method);
    if (request.method === "PUT") return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    if (new URL(url).searchParams.has("versioning")) return new Response("<VersioningConfiguration/>");
    return new Response(null, { headers: { "x-amz-bucket-region": "us-east-1" } });
  });
  // Cancel after the real PUT reply is available to the probe, before its validation HEAD.
  const wireRequest = S3Wire.prototype.request;
  const stop = variant === "interrupt" ? spyOn(S3Wire.prototype, "request").mockImplementation(async function (this: S3Wire, ...args) {
    const response = await wireRequest.apply(this, args);
    if (args[0] === "PUT") process.emit("SIGINT");
    return response;
  }) : undefined;
  const forward = variant === "namespace" ? spyOn(PortForwardTransport.prototype, "connect").mockImplementation(async target => {
    expect(target.host).toBe("storage");
    return { host: "127.0.0.1", port: Number(new URL(fixture.target.endpoint).port) };
  }) : undefined;
  const kube = spyOn(KubectlExecutor.prototype, "run").mockImplementation(async args => {
    let stdout: string;
    if (args.includes("view")) stdout = "test-context\nhttps://cluster.invalid";
    else if (args.includes("services") && args.includes("-A")) {
      stdout = variant === "namespace" && args.includes("metadata.name=second")
        ? "other-namespace\n" : "vke-system\n";
    }
    else if (args.includes("version") || args.includes("--raw=/version")) stdout = "{}";
    else throw new Error("Unexpected Kubernetes call: " + args.join(" "));
    return { ok: true, stdout, stderr: "", durationMs: 1, command: args, exitCode: 0, timedOut: false };
  });
  try {
    process.chdir(root);
    const names = variant && !variant.includes("interrupt") ? ["svc", "second"] : ["svc"];
    const plugin = { id: "fixture", version: "1.0.0", services: createServiceCatalog(names.map(name => ({
      name, workloads: [kubernetesServiceWorkload(name === "svc" ? "actual-k8s-svc" : name)],
      component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixture" } },
      dataSources: [{ kind: "s3", id: "files", backend: "s3-compatible", source: s3DataSource("local", async ctx => {
        if (variant === "prepare-interrupt") {
          process.emit("SIGINT");
          ctx.signal.throwIfAborted();
        }
        const other = name === "second";
        expect(ctx.target.namespace).toBe(variant === "namespace" && other ? "other-namespace" : "vke-system");
        return {
          ...fixture.target,
          endpoint: variant === "namespace" ? "http://storage:9000" : fixture.target.endpoint,
          bucket: other && (variant === "bucket" || variant === "override") ? "other-bucket" : "archive",
          credentials: other && variant === "credentials"
            ? { ...fixture.target.credentials, secretAccessKey: "other-secret" } : fixture.target.credentials,
        };
      }) }],
    }))) };
    const program = createDoctorProgram({ plugin, commands: "s3", optionDefaults: { yes: true, config: "" } });
    await program.parseAsync(["s3", "inspect", ...(variant === "override" ? ["s3://requested"] : [])], { from: "user" });
    expect(methods).toEqual(variant === "interrupt" ? ["HEAD", "GET", "PUT", "DELETE"] : canInspect ? ["HEAD", "GET", "PUT"] : []);
    if (variant === "prepare-interrupt") {
      expect(process.exitCode).toBe(130);
      return;
    }
    const archive = join(root, "s3-inspect.tar.gz");
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    const read = (file: string) => execFileSync("tar", ["-xOzf", archive, file], { encoding: "utf8" });
    const summary = read(files.find(f => f.endsWith("summary.md"))!);
    expect(summary).not.toContain("test-secret");
    expect(summary).not.toContain("other-secret");
    const diagnosis = JSON.parse(read(files.find(f => f.endsWith("diagnosis.json"))!));
    if (variant === "interrupt") {
      expect(process.exitCode).toBe(130);
      expect(diagnosis.status).toBe("cancelled");
      const result = JSON.parse(read(files.find(f => f.endsWith("/" + diagnosis.resultFile))!));
      expect(result.inspection.chunk.samples).toMatchObject([{ cleanup: "deleted", versionId: "fixture-v1" }]);
    } else if (canInspect) {
      expect(summary).toContain("未测出");
      expect(summary).toContain("AccessDenied");
      expect(diagnosis).toMatchObject({ status: "partial", target: { namespace: "vke-system", service: "svc", configuredBucket: "archive" },
        request: { bucket: variant === "override" ? "requested" : "archive" } });
    } else {
      expect(diagnosis.status).toBe("failed");
      expect(diagnosis.reason).toContain("候选");
      expect(diagnosis.reason).toContain("/ svc /");
      expect(diagnosis.reason).toContain("/ second /");
    }
  } finally {
    process.chdir(previous); process.exitCode = exitCode ?? 0;
    kube.mockRestore(); forward?.mockRestore(); stop?.mockRestore();
    await fixture.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("a stalled DELETE expires under the cleanup budget and retains the unresolved key", async () => {
  const run = new AbortController();
  let attempted: string | undefined;
  const result = await probeChunkLimit({ request: async () => {
    run.abort();
    return { status: 200, headers: { "x-amz-version-id": "v1" }, body: Buffer.alloc(0) };
  } }, {
    headObject: async () => { throw run.signal.reason; },
    deleteObject: async (_bucket, key, options) => {
      attempted = key;
      const signal = options!.signal!;
      signal.throwIfAborted();
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  }, "bucket", run.signal);
  expect(result.samples).toHaveLength(1);
  expect(result.samples[0]).toMatchObject({ key: attempted, versionId: "v1", cleanup: expect.stringContaining("unconfirmed") });
}, 8000);

test("non-default chunk ceiling, byte budget and cleanup errors preserve only measured bounds", async () => {
  let size = 0, limit = 8 * 1024 ** 2;
  const wire = { request: async (_method: "HEAD" | "PUT", _key: string, _signal: AbortSignal, bytes = 0) => {
    size = bytes;
    return { status: size > limit ? 400 : 200, headers: {}, body: Buffer.from("<Error><Message>chunk too big</Message></Error>") };
  } };
  const objects = { headObject: async () => ({ size, metadata: {} }), deleteObject: async () => {} };
  const probe = () => probeChunkLimit(wire, objects, "bucket", new AbortController().signal);
  const capped = await probe();
  expect(capped.maxChunkBytes).toBe(limit);
  expect(capped.samples.map(s => s.bytes)).toEqual([16777216, 8388608, 8388609]);
  expect(capped.samples.map(s => s.outcome)).toEqual(["size-rejected", "accepted", "size-rejected"]);
  limit = 4 * 1024 ** 2;
  const smaller = await probe();
  expect(smaller.maxChunkBytes).toBe(limit);
  expect(smaller.samples.map(s => s.bytes)).toEqual([16777216, 8388608, 4194304, 4194305]);
  limit = Number.MAX_SAFE_INTEGER;
  expect(await probe()).toMatchObject({ acceptedBytes: 64 * 1024 ** 2, stoppedReason: "budget" });
  objects.deleteObject = async () => { throw new Error("cleanup failed"); };
  const partial = await probe();
  expect(partial.maxChunkBytes).toBeUndefined();
  expect(partial.samples).toHaveLength(1);
  expect(partial.samples[0]?.cleanup).toContain("unconfirmed");
});
