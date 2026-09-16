import type { ServiceS3StoreCapability } from "@compforge/doctor-plugin";
import { dataSourceKey } from "@compforge/harness-toolbox/datasource";
import { KubernetesClient } from "@compforge/harness-toolbox/kubernetes/client";
import type { S3ObjectPage, S3Target } from "@compforge/harness-toolbox/s3";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandContext } from "../src/command";
import { EvidenceBundle } from "../src/collect/evidence";
import { collectedFact, unavailableFact } from "../src/collect/protocol";
import { scanS3Objects } from "../src/collect/store/s3-inventory";
import type { S3CommandContext } from "../src/collect/store/s3/context";
import { makeS3AccessInspect, makeS3Probes, type S3InspectionFacts } from "../src/collect/store/s3";
import { startS3Fixture } from "./s3-fixture";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function context(target: S3Target, command = new CommandContext({})): S3CommandContext {
  const dir = mkdtempSync(join(tmpdir(), "doctor-s3-client-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => command.disposeClients());
  const capability: ServiceS3StoreCapability = {
    id: "objects", kind: "s3", backend: "s3-compatible",
    environment: { endpoint: "S3_ENDPOINT", bucket: "S3_BUCKET", region: "S3_REGION",
      accessKey: "S3_ACCESS_KEY", secretKey: "S3_SECRET_KEY" },
  };
  return {
    command, target, originalEndpoint: new URL(target.endpoint), serviceBucket: "configured",
    capability, log: () => {},
    executor: {
      run: async () => { throw new Error("unexpected kubectl"); },
      exec: async () => { throw new Error("unexpected pod exec"); },
    },
    config: {
      collect: { profileName: "test", kubernetes: {
        namespace: "test", namespaceSource: "default", kubeconfigSource: "default",
      } },
      service: "app", capability, target: { pod: "app-0" },
      s3MaxObjects: 100, s3ScanTimeoutMs: 2000, outputFormat: "bundle",
    },
    bundle: new EvidenceBundle(dir, ["access-preparation", "bucket-access", "object-inventory"].map(id => ({
      id, title: id, risk: "observe",
    }))),
  };
}

function facts(target: S3Target): S3InspectionFacts {
  return {
    configuration: collectedFact("store.s3.configuration", "s3-configuration", {
      backend: "s3-compatible", endpoint: target.endpoint, bucket: "configured", region: target.region,
      addressStyle: "path", credentials: "configured", source: "test",
    }),
    access: collectedFact("store.s3.access", "s3-access", { channel: "direct", endpoint: target.endpoint }),
    provider: unavailableFact("store.s3.provider", "s3-provider", "not needed"),
  };
}

async function access(ctx: S3CommandContext) {
  const result = await makeS3AccessInspect().run(ctx, facts(ctx.target!));
  expect(result.access?.status).toBe("collected");
  return result;
}

async function probe(id: string, ctx: S3CommandContext) {
  return makeS3Probes().find(candidate => candidate.id === id)!.run(ctx, facts(ctx.target!), ctx.config, []);
}

test("S3 access 初始化不探测权限；同根同身份共享 Client，由根统一释放", async () => {
  let requests = 0;
  const fixture = await startS3Fixture(() => { requests += 1; return new Response(null); });
  cleanups.push(() => fixture.close());
  const first = context(fixture.target);
  const second = context(fixture.target, first.command);
  second.serviceBucket = "other";
  await access(first);
  await access(second);
  expect(requests).toBe(0);
  expect(second.client).toBe(first.client);
  await first.client!.headBucket("configured");
  const different = context({ ...fixture.target,
    credentials: { ...fixture.target.credentials, secretAccessKey: "other-secret" },
  }, first.command);
  await access(different);
  expect(different.client).not.toBe(first.client);
  await first.command.disposeClients();
  expect(() => second.client!.headBucket("other")).toThrow("disposed");
});

test("Kubernetes 转发保留 S3 原始 Host 与签名，复用根 Kubernetes Client", async () => {
  const hosts: string[] = [];
  const fixture = await startS3Fixture((_url, request) => {
    hosts.push(request.headers.get("host")!);
    expect(request.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
    return new Response(null);
  });
  cleanups.push(() => fixture.close());
  const ctx = context({ ...fixture.target, endpoint: "http://minio.test.svc.cluster.local:9000" });
  const kube = { namespace: "test", kubeconfig: undefined, context: undefined };
  const kubernetes = await ctx.command.clients.get({
    key: dataSourceKey("kubernetes", kube), createClient: signal => new KubernetesClient(kube, signal),
  });
  const forward = spyOn(kubernetes, "forward").mockResolvedValue({
    host: "127.0.0.1", port: Number(new URL(fixture.target.endpoint).port),
  });
  cleanups.push(() => forward.mockRestore());
  const result = await access(ctx);
  expect(result.access).toMatchObject({ channel: "service-port-forward", endpoint: fixture.target.endpoint });
  await ctx.client!.headBucket("configured");
  expect(hosts).toEqual(["minio.test.svc.cluster.local:9000"]);
  expect(forward).toHaveBeenCalledWith("test", expect.objectContaining({ host: "minio.test.svc.cluster.local", port: 9000 }));
});

test.each(["forbidden", "truncated"])("Bucket 发现 %s 时保留原因并检查配置 Bucket", async mode => {
  const methods: string[] = [];
  const fixture = await startS3Fixture((_url, request) => {
    methods.push(request.method);
    if (request.method === "HEAD") return new Response(null);
    return mode === "forbidden"
      ? new Response("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>", { status: 403 })
      : new Response("<ListAllMyBucketsResult><Buckets><Bucket><Name>other</Name></Bucket></Buckets><ContinuationToken>more</ContinuationToken></ListAllMyBucketsResult>");
  });
  cleanups.push(() => fixture.close());
  const ctx = context(fixture.target);
  await access(ctx);
  expect(await probe("bucket-access", ctx)).toMatchObject([{
    ok: true, buckets: ["configured"], discovery: "configured-bucket-fallback",
    discoveryReason: expect.any(String),
  }]);
  expect(methods).toEqual(["GET", "HEAD"]);
});

test("Bucket 拒绝访问不伪装成不存在或健康", async () => {
  const fixture = await startS3Fixture(() => new Response(null, { status: 403 }));
  cleanups.push(() => fixture.close());
  const ctx = context(fixture.target);
  await access(ctx);
  expect(await probe("bucket-access", ctx)).toEqual([]);
  expect(ctx.accessibleBuckets).toBeUndefined();
});

test("标准 S3 列桶、versioning 和带转义 key 的分页对象画像走 toolbox", async () => {
  const tokens: Array<string | null> = [];
  const fixture = await startS3Fixture(url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/") {
      return new Response("<ListAllMyBucketsResult><Buckets><Bucket><Name>configured</Name></Bucket><Bucket><Name>archive&amp;cold</Name></Bucket></Buckets></ListAllMyBucketsResult>");
    }
    if (parsed.searchParams.has("versioning")) return new Response("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
    const token = parsed.searchParams.get("continuation-token");
    tokens.push(token);
    return new Response(`<ListBucketResult><IsTruncated>${!token}</IsTruncated>
      ${token ? "" : "<NextContinuationToken>next&amp;token</NextContinuationToken>"}
      <Contents><Key>knowledge/${token ? "b" : "a&amp;b"}.txt</Key><Size>10</Size>
      <LastModified>2026-08-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>`);
  });
  cleanups.push(() => fixture.close());
  const ctx = context(fixture.target);
  await access(ctx);
  expect(await probe("bucket-access", ctx)).toMatchObject([{ buckets: ["configured", "archive&cold"] }]);
  ctx.accessibleBuckets = ["configured"];
  ctx.inventoryPrefix = "knowledge";
  expect(await probe("object-inventory", ctx)).toMatchObject([{
    buckets: [{ versioning: "enabled", status: "complete", pages: 2, objects: 2, bytes: 20,
      topObjects: expect.arrayContaining([expect.objectContaining({ key: "knowledge/a&b.txt" })]) }],
  }]);
  expect(tokens).toEqual([null, "next&token"]);
});

test.each([
  { objects: [{ key: "bad" }], prefixes: [], truncated: false },
  { objects: [], prefixes: [], truncated: true },
] satisfies S3ObjectPage[])("不完整 metadata 或缺少分页 token 不算完整画像", async page => {
  await expect(scanS3Objects({
    client: { signal: new AbortController().signal, listObjects: async () => page },
    bucket: "configured", maxObjects: 10, timeoutMs: 1000,
  })).rejects.toThrow("ListObjectsV2");
});

test("扫描剩余时间传给 SDK，超时仍交付已有页", async () => {
  let calls = 0;
  const inventory = await scanS3Objects({
    client: { signal: new AbortController().signal, listObjects: async (_bucket, options) => {
      calls += 1;
      if (calls === 1) return { objects: [{ key: "a", size: 10, lastModified: new Date() }],
        prefixes: [], truncated: true, continuationToken: "next" };
      return new Promise((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
    } },
    bucket: "configured", prefix: "a", maxObjects: 10, timeoutMs: 30,
  });
  expect(inventory).toMatchObject({ status: "partial", stoppedReason: "time-limit", objects: 1, pages: 1 });
});

test("根取消不会被误当成扫描预算耗尽", async () => {
  const controller = new AbortController();
  await expect(scanS3Objects({
    client: { signal: controller.signal, listObjects: async () => {
      controller.abort(new Error("root cancelled"));
      throw new DOMException("aborted", "AbortError");
    } },
    bucket: "configured", maxObjects: 10, timeoutMs: 1000,
  })).rejects.toThrow("root cancelled");
});
