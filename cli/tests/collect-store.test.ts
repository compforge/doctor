import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenSearchReadApi } from "../src/infra/search/opensearch";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";
import { EvidenceBundle } from "../src/collect/evidence";
import { runProbes } from "../src/collect/probe-engine";
import {
  detectVdbFindings,
  groupVdbObservations,
  makeVdbProbes,
  parseVdbConnection,
  sanitizeVdbConnection,
  vdbCapacityConclusion,
  type VdbObservations,
} from "../src/collect/store/vdb";
import type { VdbConfig } from "../src/collect/store/vdb/config";
import type { VdbCommandContext } from "../src/collect/store/vdb/context";
import { CommandContext } from "../src/command";
import type { VdbInspectionFacts } from "../src/collect/store/vdb/fact";
import {
  buildDbCoverage,
  detectDbFindings,
  makeDbProbes,
  type DbInspectionFacts,
} from "../src/collect/store/db";
import {
  buildS3HtmlReport,
  buildS3Coverage,
  detectS3CapacityFinding,
  detectS3Findings,
  makeS3Probes,
  type S3InspectionFacts,
} from "../src/collect/store/s3";
import { configuredValue, parseEnvironment } from "../src/collect/store/runtime-config";
import { scanS3Objects, summarizeS3Objects } from "../src/collect/store/s3-inventory";
import {
  inspectS3Provider,
  parseListBucketsXml,
  parseListObjectsV2Xml,
} from "../src/infra/object-store";
import {
  getMinioBucketUsage,
  parseMinioBucketUsageMetrics,
  parseMinioTenantCapacity,
} from "../src/infra/object-store/s3/minio";
import {
  buildMysqlLoadFact,
  detectMysqlFindings,
  parseMysqlStatusSnapshot,
} from "../src/collect/store/mysql-diagnosis";
import {
  parseStoreKinds,
  parseStoreOutputFormat,
  resolveStoreProviderConfig,
  resolveStoreOutputPath,
} from "../src/collect/store";
import { writeStoreArtifacts } from "../src/collect/store/artifacts";
import { writeTabbedStoreReport } from "../src/collect/store/tabs";
import { writeHtmlReport } from "../src/collect/output/html";

test("Store 类型支持一次选择多个并保持首次出现顺序", () => {
  expect(parseStoreKinds("db,redis,s3,db")).toEqual(["db", "redis", "s3"]);
  expect(parseStoreKinds(undefined)).toEqual([]);
  expect(() => parseStoreKinds("db,k8s")).toThrow("只支持 db、vdb、s3、redis");
});

test("VDB capability 自行贡献 target 时 Core 不要求同名 Service/Pod 已部署", async () => {
  const command = ["get", "services", "-o", "json"];
  const result: ExecResult = {
    ok: true,
    exitCode: 0,
    stdout: '{"items":[]}',
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command,
  };
  const executor: Executor = {
    run: async () => result,
    exec: async () => { throw new Error("Core 不应读取配置来源 Pod"); },
  };
  const plugin = {
    id: "test",
    version: "0.0.1",
    services: createServiceCatalog([{
      name: "logical-opensearch-provider",
      capabilities: {
        stores: [{
          id: "trace",
          kind: "vdb",
          backend: "opensearch",
          access: {},
          inspectTarget: async () => ({
            backend: "opensearch",
            store: "opensearch",
            endpoint: "http://opensearch.storage:9200",
            configurationKind: "plugin",
          }),
        }],
      },
    }]),
  } satisfies PluginDefinition;

  const resolved = await resolveStoreProviderConfig({
    type: "vdb",
    service: "logical-opensearch-provider",
    store: "trace",
  }, plugin, {
    profileName: "test",
    kubernetes: {
      kubeconfigSource: "test",
      namespace: "app",
      namespaceSource: "flag",
    },
  }, executor, new CommandContext({}));

  expect(resolved?.config.target).toBeUndefined();
  expect(resolved?.config.vdbTarget).toMatchObject({
    endpoint: "http://opensearch.storage:9200",
    configurationKind: "plugin",
  });
});

describe("Store output", () => {
  test("Store 默认双交付，并按显式 format 补全后缀", () => {
    expect(parseStoreOutputFormat(undefined)).toBe("default");
    expect(resolveStoreOutputPath(undefined, "doctor-store-db-1", "html")).toBe("doctor-store-db-1.html");
    expect(resolveStoreOutputPath("report", "ignored", "md")).toBe("report.md");
    expect(resolveStoreOutputPath("report", "ignored", "bundle")).toBe("report.tar.gz");
    expect(() => resolveStoreOutputPath("report.tar.gz", "ignored", "html")).toThrow("不能使用");
  });

  test("原生 Store 成功交付单文件 HTML，且现场文本不会注入 HTML", async () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-store-output-test-"));
    const staging = join(root, "bundle");
    const bundle = new EvidenceBundle(staging, []);
    const summary = "# DB Store 诊断摘要\n\n- Service: `<script>alert(1)</script>`\n- Reason: <script>alert(2)</script>\n";
    bundle.writeSummary(summary);
    bundle.writeManifest({
      doctorVersion: "test",
      target: { store_kind: "db" },
      inspectionFacts: {},
      params: {},
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
    });
    const outputPath = join(root, "report.html");
    const prepared = await writeStoreArtifacts({
      staging,
      bundleName: "bundle",
      outputPath,
      format: "html",
      code: 0,
      title: "doctor DB Store 诊断报告",
      profileName: "test",
      summary,
    });
    const html = readFileSync(join(staging, "report.html"), "utf8");
    expect(prepared).toMatchObject({ ok: true, path: staging, label: "Store 诊断产物" });
    expect(html).toContain(">DB Store 诊断摘要</h1>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(2)</script>");
    rmSync(root, { recursive: true, force: true });
  });

  test("多 Store HTML 汇总为隔离的 Tab 页面", () => {
    const root = mkdtempSync(join(tmpdir(), "doctor-store-tabs-test-"));
    const outputPath = join(root, "store.html");
    writeTabbedStoreReport(outputPath, [
      { kind: "db", status: "delivered", html: "<!doctype html><h1>DB report</h1>" },
      { kind: "redis", status: "delivered", html: "<!doctype html><h1>Redis report</h1>" },
    ]);
    const html = readFileSync(outputPath, "utf8");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-kind="db"');
    expect(html).toContain('data-kind="redis"');
    expect(html).toContain("已交付");
    expect(html).toContain("frame.srcdoc=new TextDecoder().decode(bytes)");
    rmSync(root, { recursive: true, force: true });
  });

  test("S3 HTML 按 Bucket 和一级 Prefix 联动展示容量与 Object 画像", () => {
    const report = buildS3HtmlReport({
      bucketAccess: {
        id: "s3-bucket-access",
        kind: "s3-bucket-access",
        ok: true,
        httpStatus: 200,
        discovery: "list-buckets",
        buckets: ["xai-test", "archive"],
      },
      bucketUsage: {
        id: "s3-bucket-usage",
        kind: "s3-bucket-usage",
        providerId: "minio",
        providerDisplayName: "MinIO",
        metricsEndpoint: "/minio/metrics/v3/cluster/usage/buckets",
        buckets: [
          { bucket: "xai-test", bytes: 46 * 1024 ** 3, objects: 80_000, sinceLastUpdateSeconds: 12 },
          { bucket: "archive", bytes: 4 * 1024 ** 3, objects: 2_000, sinceLastUpdateSeconds: 12 },
        ],
      },
      capacity: {
        id: "s3-capacity",
        kind: "s3-capacity",
        providerId: "minio",
        title: "MinIO Tenant minio/minio",
        rawCapacityBytes: 800 * 1024 ** 3,
        rawUsageBytes: 753 * 1024 ** 3,
        rawFreeBytes: 47 * 1024 ** 3,
        rawUsagePercent: 94.125,
      },
      inventory: {
        id: "s3-object-inventory",
        kind: "s3-object-inventory",
        discoveredBuckets: 1,
        scannedBuckets: 1,
        buckets: [{
          bucket: "xai-test",
          serviceFocus: true,
          focusPrefix: "knowledge",
          status: "partial",
          scopePrefix: "",
          pages: 33,
          objects: 33_000,
          bytes: 25 * 1024 ** 3,
          ageDistribution: [
            { range: "<7d", objects: 10, bytes: 1024 ** 3 },
            { range: "7-30d", objects: 20, bytes: 2 * 1024 ** 3 },
            { range: "30-90d", objects: 30, bytes: 3 * 1024 ** 3 },
            { range: "90-365d", objects: 40, bytes: 4 * 1024 ** 3 },
            { range: ">=365d", objects: 32_900, bytes: 15 * 1024 ** 3 },
          ],
          reclaimable: [],
          prefixMode: "top-n",
          discoveredFirstLevelPrefixes: 24,
          topObjects: [{
            key: "knowledge/<unsafe>/largest.bin",
            bytes: 9 * 1024 ** 3,
            lastModified: "2026-08-01T08:30:00.000Z",
          }],
          firstLevelPrefixes: [
            {
              prefix: "knowledge/<unsafe>",
              status: "sampled",
              objects: 10_000,
              bytes: 8 * 1024 ** 3,
              latestLastModified: "2026-08-01T08:30:00.000Z",
              secondLevelPrefixes: [
                {
                  prefix: "knowledge/<unsafe>/documents",
                  objects: 8_000,
                  bytes: 7 * 1024 ** 3,
                  latestLastModified: "2026-07-31T07:20:00.000Z",
                },
              ],
              topObjects: [{
                key: "knowledge/<unsafe>/largest.zip",
                bytes: 7 * 1024 ** 3,
                lastModified: "2026-08-01T08:30:00.000Z",
              }],
              ageDistribution: [
                { range: "<7d", objects: 1, bytes: 7 * 1024 ** 3 },
                { range: ">=365d", objects: 2, bytes: 1024 ** 3 },
              ],
              extensionDistribution: [
                { extension: ".zip", objects: 1, bytes: 7 * 1024 ** 3 },
                { extension: ".html", objects: 2, bytes: 1024 ** 3 },
              ],
            },
            {
              prefix: "knowledge/b",
              status: "sampled",
              objects: 5_000,
              bytes: 4 * 1024 ** 3,
              latestLastModified: "2026-07-30T06:10:00.000Z",
              secondLevelPrefixes: [],
              topObjects: [],
              ageDistribution: [],
              extensionDistribution: [],
            },
          ],
          otherFirstLevelPrefixes: {
            prefixes: 22,
            objects: 18_000,
            bytes: 13 * 1024 ** 3,
          },
          note: "partial",
          versioning: "disabled",
        }],
      },
    });

    expect(report.sections).toHaveLength(4);
    expect(report.sections[0]).toMatchObject({ title: "物理容量" });
    expect(report.sections[0]?.html).toContain("metric-fill-critical");
    expect(report.sections[0]?.html).toContain("剩余 47.00 GiB");
    expect(report.sections[1]).toMatchObject({ title: "Bucket 容量分布" });
    expect(report.sections[1]?.html).toContain("Bucket 对象占用占比");
    expect(report.sections[1]?.html).toContain("与 Prefix 图使用同一次 ListObjectsV2 扫描");
    expect(report.sections[1]?.html).toContain("25.00 GiB");
    expect(report.sections[1]?.html).not.toContain("46.00 GiB");
    expect(report.sections[1]?.html).not.toContain("MinIO Bucket Usage Metrics");
    expect(report.sections[1]?.html).toContain("xai-test");
    expect(report.sections[2]).toMatchObject({ title: "Prefix 容量分布" });
    expect(report.sections[2]?.html).toContain("report-switcher-select");
    expect(report.sections[2]?.html).toContain("Service 关注");
    expect(report.sections[2]?.html).toContain("knowledge/&lt;unsafe&gt;");
    expect(report.sections[2]?.html).not.toContain("knowledge/<unsafe>");
    expect(report.sections[2]?.html).toContain("发现 24 个一级 Prefix");
    expect(report.sections[2]?.html).toContain("其它一级 Prefix（22）");
    expect(report.sections[2]?.html).toContain("13.00 GiB");
    expect(report.sections[3]).toMatchObject({ title: "Prefix 下一级 Object 分布" });
    expect(report.sections[3]?.html).toContain("report-cascade-parent-select");
    expect(report.sections[3]?.html).toContain("report-cascade-child-select");
    expect(report.sections[3]?.html).toContain("第二级 Prefix（Top 1）");
    expect(report.sections[3]?.html).toContain("采样 Object Top 1");
    expect(report.sections[3]?.html).toContain("采样 Object 年龄分布");
    expect(report.sections[3]?.html).toContain("采样 Object 文件扩展名分布");
    expect(report.sections[3]?.html).toContain("knowledge/&lt;unsafe&gt;/documents");
    expect(report.sections[3]?.html).toContain(".zip");
    expect(report.sections[3]?.html).toContain(".html");
    expect(report.sections[3]?.html).toContain("最近修改 2026-08-01 08:30:00 UTC");
    expect(report.sections[3]?.html).toContain("最近修改 2026-07-31 07:20:00 UTC");
    expect(report.sections[3]?.html).toContain("87.5%");

    const root = mkdtempSync(join(tmpdir(), "doctor-s3-report-test-"));
    const bundle = new EvidenceBundle(root, []);
    bundle.writeSummary("# S3 Store 诊断摘要\n");
    bundle.writeManifest({
      doctorVersion: "test",
      target: { store_kind: "s3" },
      inspectionFacts: { "s3.configuration": { status: "collected" } },
      params: {},
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
    });
    const outputPath = join(root, "report.html");
    writeHtmlReport(root, outputPath, {
      profileName: "test",
      summaryHtml: "<h1>S3 Store 诊断摘要</h1>",
      ...report,
    });
    const html = readFileSync(outputPath, "utf8");
    expect(html).toContain("conic-gradient");
    expect(html).toContain("753.00 GiB / 800.00 GiB");
    expect(html).toContain("94.1%");
    expect(html).toContain("bar-chart-fill");
    expect(html.indexOf("诊断摘要")).toBeLessThan(html.indexOf("物理容量"));
    expect(html.indexOf("物理容量")).toBeLessThan(html.indexOf("Bucket 容量分布"));
    expect(html.indexOf("Bucket 容量分布")).toBeLessThan(html.indexOf("Prefix 容量分布"));
    expect(html.indexOf("Prefix 容量分布")).toBeLessThan(html.indexOf("Prefix 下一级 Object 分布"));
    expect(html.indexOf("Prefix 下一级 Object 分布")).toBeLessThan(html.indexOf("Inspect Facts"));
    expect(html.indexOf("Inspect Facts")).toBeLessThan(html.indexOf("采集步骤"));
    expect(html).not.toContain("report-inspector");
    expect(html).not.toContain("activateExchangeTab");
    expect(html).not.toContain("exchange-sse");
    rmSync(root, { recursive: true, force: true });
  });
});

function mysqlStatusRows(values: Record<string, number>): Array<Record<string, unknown>> {
  return Object.entries(values).map(([Variable_name, Value]) => ({ Variable_name, Value: String(Value) }));
}

describe("MySQL basic diagnosis", () => {
  test("DB 通过 Inspect Facts、Probe 和 Coverage 表达诊断链", () => {
    expect(makeDbProbes().map((probe) => probe.id)).toEqual([
      "health", "server-info", "capacity", "load", "lock-waits",
    ]);
    expect(makeDbProbes().find((probe) => probe.id === "load")?.dependsOn).toEqual(["server-info"]);
    const facts: DbInspectionFacts = {
      configuration: { status: "unavailable", reason: "not configured" },
      access: { status: "unavailable", reason: "not configured" },
    };
    const evidence = { observations: [], facts };
    expect(buildDbCoverage(evidence).map((item) => [item.goal, item.status])).toEqual([
      ["health", "insufficient"],
      ["capacity", "insufficient"],
      ["load", "insufficient"],
      ["lock-waits", "insufficient"],
    ]);
    expect(detectDbFindings(evidence)).toEqual([]);
  });

  test("两次 GLOBAL STATUS 快照计算窗口负载而不是误用累计值", () => {
    const before = parseMysqlStatusSnapshot(mysqlStatusRows({
      Uptime: 100,
      Queries: 1_000,
      Com_commit: 200,
      Com_rollback: 10,
      Slow_queries: 2,
      Created_tmp_disk_tables: 3,
      Aborted_connects: 1,
      Bytes_received: 10_000,
      Bytes_sent: 20_000,
      Innodb_rows_read: 5_000,
      Innodb_rows_inserted: 100,
      Innodb_rows_updated: 50,
      Innodb_rows_deleted: 10,
      Threads_connected: 70,
      Threads_running: 4,
    }), 1_000);
    const after = parseMysqlStatusSnapshot(mysqlStatusRows({
      Uptime: 105,
      Queries: 1_100,
      Com_commit: 220,
      Com_rollback: 15,
      Slow_queries: 3,
      Created_tmp_disk_tables: 5,
      Aborted_connects: 2,
      Bytes_received: 15_000,
      Bytes_sent: 30_000,
      Innodb_rows_read: 5_500,
      Innodb_rows_inserted: 120,
      Innodb_rows_updated: 60,
      Innodb_rows_deleted: 15,
      Threads_connected: 85,
      Threads_running: 8,
    }), 6_000);

    const load = buildMysqlLoadFact(before, after, 100);
    expect(load).toMatchObject({
      windowSeconds: 5,
      counterReset: false,
      current: { connectedThreads: 85, runningThreads: 8, connectionUsagePercent: 85 },
      rates: { queriesPerSecond: 20, transactionsPerSecond: 5, rowsWrittenPerSecond: 7 },
      delta: { slowQueries: 1, temporaryDiskTables: 2, abortedConnects: 1 },
    });
  });

  test("实例重启或累计计数重置时不生成虚假负载", () => {
    const before = parseMysqlStatusSnapshot(mysqlStatusRows({ Uptime: 100, Queries: 1_000 }), 1_000);
    const after = parseMysqlStatusSnapshot(mysqlStatusRows({ Uptime: 105, Queries: 5 }), 6_000);
    const load = buildMysqlLoadFact(before, after, 100);
    expect(load.counterReset).toBe(true);
    expect(load.rates.queriesPerSecond).toBeUndefined();
    expect(load.delta.slowQueries).toBeUndefined();
  });

  test("连接、拒绝、慢查询和锁等待按后果生成 Findings", () => {
    const before = parseMysqlStatusSnapshot(mysqlStatusRows({ Uptime: 100 }), 1_000);
    const after = parseMysqlStatusSnapshot(mysqlStatusRows({
      Uptime: 105,
      Threads_connected: 96,
      Aborted_connects: 1,
      Slow_queries: 2,
    }), 6_000);
    const load = buildMysqlLoadFact(before, after, 100);
    expect(detectMysqlFindings({
      queryable: true,
      load,
      locks: {
        status: "collected",
        activeTransactions: 3,
        waitingTransactions: 1,
        longestWaitSeconds: 12,
        longestTransactionSeconds: 20,
      },
    }).map((finding) => [finding.kind, finding.severity])).toEqual([
      ["db.connections-exhausted", "critical"],
      ["db.connections-rejected", "warning"],
      ["db.slow-queries-observed", "warning"],
      ["db.lock-waits-observed", "critical"],
    ]);
  });
});

describe("Store capability runtime state", () => {
  test("S3 通过 Inspect Facts、Probe 和 Coverage 表达诊断链", () => {
    expect(makeS3Probes().map((probe) => probe.id)).toEqual([
      "bucket-access", "provider-health", "bucket-usage", "object-inventory", "capacity",
    ]);
    const facts: S3InspectionFacts = {
      configuration: { status: "unavailable", reason: "not configured" },
      access: { status: "unavailable", reason: "not configured" },
      provider: { status: "unavailable", reason: "not configured" },
    };
    const evidence = { observations: [], facts };
    expect(buildS3Coverage(evidence).map((item) => [item.goal, item.status])).toEqual([
      ["bucket-access", "insufficient"],
      ["object-inventory", "insufficient"],
      ["provider-health", "partial"],
      ["capacity", "partial"],
    ]);
    expect(detectS3Findings(evidence)).toEqual([]);
  });

  test("空配置表示 Store 当前未启用", () => {
    const environment = parseEnvironment("S3_ENDPOINT=  \nS3_BUCKET_NAME=xai-test\n");
    expect(configuredValue(environment, "S3_ENDPOINT")).toBeUndefined();
    expect(configuredValue(environment, "S3_BUCKET_NAME")).toBe("xai-test");
  });

  test("MinIO 容量与健康是独立事实，94% 使用量判为 critical", () => {
    const capacity = parseMinioTenantCapacity({
      namespace: "minio",
      tenant: "minio",
      status: {
        healthStatus: "green",
        drivesOnline: 16,
        usage: { rawCapacity: 858_993_459_200, rawUsage: 808_499_200_000 },
      },
    });
    expect(capacity).toMatchObject({ healthStatus: "green", onlineUnits: 16 });
    expect(capacity?.rawUsagePercent).toBeGreaterThan(94);
    expect(detectS3CapacityFinding(capacity!)).toMatchObject({
      severity: "critical",
      kind: "s3.capacity-exhausted",
    });
  });

  test("ListObjectsV2 解析对象 metadata 与翻页 token", () => {
    const page = parseListObjectsV2Xml(`<?xml version="1.0" encoding="UTF-8"?>
      <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>next&amp;token</NextContinuationToken>
        <Contents>
          <Key>knowledge/tenant-a/a&amp;b.txt</Key>
          <LastModified>2026-07-01T00:00:00.000Z</LastModified>
          <Size>1024</Size>
        </Contents>
      </ListBucketResult>`);
    expect(page).toEqual({
      objects: [{
        key: "knowledge/tenant-a/a&b.txt",
        size: 1024,
        lastModified: new Date("2026-07-01T00:00:00.000Z"),
      }],
      commonPrefixes: [],
      isTruncated: true,
      nextContinuationToken: "next&token",
    });
  });

  test("ListBuckets 和 MinIO Bucket Usage Metrics 解析凭证可见容量", () => {
    expect(parseListBucketsXml(`<?xml version="1.0"?>
      <ListAllMyBucketsResult><Buckets>
        <Bucket><Name>xai-test</Name></Bucket>
        <Bucket><Name>archive&amp;cold</Name></Bucket>
      </Buckets></ListAllMyBucketsResult>`)).toEqual({
      buckets: ["xai-test", "archive&cold"],
    });
    expect(parseMinioBucketUsageMetrics(`
      # HELP minio_cluster_usage_buckets_total_bytes total bytes
      minio_cluster_usage_buckets_total_bytes{bucket="xai-test"} 49531715584
      minio_cluster_usage_buckets_objects_count{bucket="xai-test"} 84785
      minio_cluster_usage_buckets_since_last_update_seconds{bucket="xai-test"} 12
      minio_bucket_usage_total_bytes{bucket="archive"} 1024
      minio_bucket_usage_object_total{bucket="archive"} 2
    `)).toEqual([
      { bucket: "xai-test", bytes: 49_531_715_584, objects: 84_785, sinceLastUpdateSeconds: 12 },
      { bucket: "archive", bytes: 1024, objects: 2 },
    ]);
  });

  test("MinIO Metrics 受保护时使用 S3 身份签发 Prometheus Bearer Token 重试", async () => {
    const originalFetch = globalThis.fetch;
    const authorizations: Array<string | null> = [];
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const authorization = new Headers(init?.headers).get("authorization");
      authorizations.push(authorization);
      if (!authorization) return new Response("forbidden", { status: 403 });
      return new Response('minio_cluster_usage_buckets_total_bytes{bucket="xai-test"} 1024');
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      const usage = await getMinioBucketUsage("http://minio.example.com", {
        accessKey: "doctor-access",
        secretKey: "doctor-secret",
      });
      expect(usage.buckets).toEqual([{ bucket: "xai-test", bytes: 1024 }]);
      expect(authorizations[0]).toBeNull();
      const token = authorizations[1]?.replace("Bearer ", "") ?? "";
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
      expect(payload).toMatchObject({ sub: "doctor-access", iss: "prometheus" });
      expect(token).not.toContain("doctor-secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Provider Inspect 只启用已识别扩展，未知厂商保留通用 S3 能力", async () => {
    const originalFetch = globalThis.fetch;
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return new Response("", { status: url.hostname === "minio.example.com" ? 200 : 404 });
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      await expect(inspectS3Provider({ endpoint: "http://minio.example.com" })).resolves.toMatchObject({
        providerId: "minio",
        capabilities: { health: true, bucketUsage: true, physicalCapacity: true },
      });
      await expect(inspectS3Provider({ endpoint: "https://s3-compatible.example.com" })).resolves.toEqual({
        providerId: "generic-s3",
        displayName: "S3 Compatible",
        detection: "s3-api",
        capabilities: { health: false, bucketUsage: false, physicalCapacity: false },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("全 Bucket 扫描先覆盖 Service Prefix，再公平推进其它顶层 Prefix", async () => {
    const originalFetch = globalThis.fetch;
    const prefixes: string[] = [];
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix") ?? "";
      prefixes.push(prefix || "(root)");
      if (!prefix && url.searchParams.get("delimiter") === "/") {
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>
          <CommonPrefixes><Prefix>artifact/</Prefix></CommonPrefixes>
          <CommonPrefixes><Prefix>knowledge/</Prefix></CommonPrefixes>
        </ListBucketResult>`);
      }
      const key = prefix === "knowledge/" ? "knowledge/focus.bin" : "artifact/large.bin";
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
        <Key>${key}</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified><Size>10</Size>
      </Contents></ListBucketResult>`);
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      const inventory = await scanS3Objects({
        target: {
          endpoint: "http://s3.example.com",
          bucket: "xai-test",
          region: "us-east-1",
          accessKey: "access",
          secretKey: "secret",
          pathStyle: true,
        },
        priorityPrefix: "knowledge",
        maxObjects: 2,
        timeoutMs: 10_000,
      });
      expect(prefixes).toEqual(["(root)", "knowledge/", "artifact/"]);
      expect(inventory).toMatchObject({ status: "complete", objects: 2, bytes: 20 });
      expect(inventory.topObjects.map((row) => row.key).sort()).toEqual([
        "artifact/large.bin",
        "knowledge/focus.bin",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Prefix 公平扫描继续发现次级目录，避免大目录藏在较小兄弟目录之后", async () => {
    const originalFetch = globalThis.fetch;
    const prefixes: string[] = [];
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix") ?? "";
      const delimiter = url.searchParams.get("delimiter");
      prefixes.push(`${prefix || "(root)"}${delimiter ? " [delimiter]" : ""}`);
      if (!prefix) {
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>
          <CommonPrefixes><Prefix>artifact/</Prefix></CommonPrefixes>
          <CommonPrefixes><Prefix>knowledge/</Prefix></CommonPrefixes>
        </ListBucketResult>`);
      }
      if (prefix === "artifact/" && delimiter) {
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>
          <CommonPrefixes><Prefix>artifact/-toolkit/</Prefix></CommonPrefixes>
          <CommonPrefixes><Prefix>artifact/s/</Prefix></CommonPrefixes>
        </ListBucketResult>`);
      }
      const key = prefix === "knowledge/"
        ? "knowledge/focus.bin"
        : prefix === "artifact/s/" ? "artifact/s/large.bin" : "artifact/-toolkit/small.bin";
      const size = prefix === "artifact/s/" ? 10_000 : 10;
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
        <Key>${key}</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified><Size>${size}</Size>
      </Contents></ListBucketResult>`);
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      const inventory = await scanS3Objects({
        target: {
          endpoint: "http://s3.example.com",
          bucket: "xai-test",
          region: "us-east-1",
          accessKey: "access",
          secretKey: "secret",
          pathStyle: true,
        },
        priorityPrefix: "knowledge",
        maxObjects: 3,
        timeoutMs: 10_000,
      });
      expect(prefixes).toEqual([
        "(root) [delimiter]",
        "knowledge/ [delimiter]",
        "artifact/ [delimiter]",
        "artifact/-toolkit/",
        "artifact/s/",
      ]);
      expect(inventory.topObjects[0]).toMatchObject({ key: "artifact/s/large.bin", bytes: 10_000 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("一级 Prefix 超过阈值时公平采样并只返回样本容量 Top 10", async () => {
    const originalFetch = globalThis.fetch;
    const requestedPrefixes: string[] = [];
    const rootPrefixes = Array.from({ length: 21 }, (_, index) => `prefix-${index.toString().padStart(2, "0")}/`);
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!prefix) {
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${rootPrefixes.map((item) =>
          `<CommonPrefixes><Prefix>${item}</Prefix></CommonPrefixes>`
        ).join("")}</ListBucketResult>`);
      }
      requestedPrefixes.push(prefix);
      const index = Number(prefix.match(/\d+/)?.[0] ?? 0);
      return new Response(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><Contents>
        <Key>${prefix}sample-${index}.zip</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified><Size>${index + 1}</Size>
      </Contents></ListBucketResult>`);
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      const inventory = await scanS3Objects({
        target: {
          endpoint: "http://s3.example.com",
          bucket: "xai-test",
          region: "us-east-1",
          accessKey: "access",
          secretKey: "secret",
          pathStyle: true,
        },
        priorityPrefix: "prefix-20",
        maxObjects: 100,
        timeoutMs: 10_000,
      });
      expect(requestedPrefixes).toHaveLength(21);
      expect(requestedPrefixes[0]).toBe("prefix-20/");
      expect(inventory).toMatchObject({
        status: "partial",
        prefixMode: "top-n",
        discoveredFirstLevelPrefixes: 21,
        objects: 21,
      });
      expect(inventory.firstLevelPrefixes).toHaveLength(10);
      expect(inventory.firstLevelPrefixes.map((row) => row.prefix)).toEqual([
        "prefix-20", "prefix-19", "prefix-18", "prefix-17", "prefix-16",
        "prefix-15", "prefix-14", "prefix-13", "prefix-12", "prefix-11",
      ]);
      expect(inventory.firstLevelPrefixes.every((row) => row.status === "sampled")).toBe(true);
      expect(inventory.otherFirstLevelPrefixes).toEqual({ prefixes: 11, objects: 11, bytes: 66 });
      expect(inventory.firstLevelPrefixes[0]?.extensionDistribution).toEqual([
        { extension: ".zip", objects: 1, bytes: 21 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Bucket 根目录 Object 归入统一的 bucket-root 分组", () => {
    const inventory = summarizeS3Objects({
      now: new Date("2026-08-03T00:00:00.000Z"),
      complete: true,
      pages: 1,
      objects: [
        { key: "root.zip", size: 20, lastModified: new Date("2026-08-01T00:00:00.000Z") },
        { key: "artifacts/page.html", size: 10, lastModified: new Date("2026-08-01T00:00:00.000Z") },
      ],
    });
    expect(inventory.firstLevelPrefixes.map((row) => [row.prefix, row.bytes])).toEqual([
      ["(bucket-root)", 20],
      ["artifacts", 10],
    ]);
  });

  test("对象画像按 prefix 和 7/30/90/365 天估算可回收逻辑空间", () => {
    const inventory = summarizeS3Objects({
      scopePrefix: "knowledge",
      now: new Date("2026-08-03T00:00:00.000Z"),
      complete: true,
      pages: 1,
      objects: [
        { key: "knowledge/tenant-a/docs/new", size: 10, lastModified: new Date("2026-08-01T00:00:00.000Z") },
        { key: "knowledge/tenant-a/docs/month", size: 20, lastModified: new Date("2026-07-10T00:00:00.000Z") },
        { key: "knowledge/tenant-b/archive/quarter.html", size: 30, lastModified: new Date("2026-06-01T00:00:00.000Z") },
        { key: "knowledge/tenant-b/archive/year", size: 40, lastModified: new Date("2026-01-01T00:00:00.000Z") },
        { key: "knowledge/tenant-b/legacy/old.zip", size: 50, lastModified: new Date("2024-01-01T00:00:00.000Z") },
      ],
    });
    expect(inventory).toMatchObject({ status: "complete", objects: 5, bytes: 150 });
    expect(inventory.ageDistribution).toEqual([
      { range: "<7d", objects: 1, bytes: 10 },
      { range: "7-30d", objects: 1, bytes: 20 },
      { range: "30-90d", objects: 1, bytes: 30 },
      { range: "90-365d", objects: 1, bytes: 40 },
      { range: ">=365d", objects: 1, bytes: 50 },
    ]);
    expect(inventory).toMatchObject({
      prefixMode: "all",
      discoveredFirstLevelPrefixes: 2,
    });
    expect(inventory.firstLevelPrefixes.map((prefix) => ({
      prefix: prefix.prefix,
      status: prefix.status,
      objects: prefix.objects,
      bytes: prefix.bytes,
      latestLastModified: prefix.latestLastModified,
      secondLevelPrefixes: prefix.secondLevelPrefixes,
    }))).toEqual([
      {
        prefix: "knowledge/tenant-b",
        status: "complete",
        objects: 3,
        bytes: 120,
        latestLastModified: "2026-06-01T00:00:00.000Z",
        secondLevelPrefixes: [
          {
            prefix: "knowledge/tenant-b/archive",
            objects: 2,
            bytes: 70,
            latestLastModified: "2026-06-01T00:00:00.000Z",
          },
          {
            prefix: "knowledge/tenant-b/legacy",
            objects: 1,
            bytes: 50,
            latestLastModified: "2024-01-01T00:00:00.000Z",
          },
        ],
      },
      {
        prefix: "knowledge/tenant-a",
        status: "complete",
        objects: 2,
        bytes: 30,
        latestLastModified: "2026-08-01T00:00:00.000Z",
        secondLevelPrefixes: [
          {
            prefix: "knowledge/tenant-a/docs",
            objects: 2,
            bytes: 30,
            latestLastModified: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    ]);
    expect(inventory.firstLevelPrefixes[0]?.topObjects[0]).toMatchObject({
      key: "knowledge/tenant-b/legacy/old.zip",
      bytes: 50,
    });
    expect(inventory.firstLevelPrefixes[0]?.extensionDistribution).toEqual([
      { extension: ".zip", objects: 1, bytes: 50 },
      { extension: "(无扩展名)", objects: 1, bytes: 40 },
      { extension: ".html", objects: 1, bytes: 30 },
    ]);
    expect(inventory.reclaimable).toEqual([
      { olderThanDays: 7, objects: 4, bytes: 140 },
      { olderThanDays: 30, objects: 3, bytes: 120 },
      { olderThanDays: 90, objects: 2, bytes: 90 },
      { olderThanDays: 365, objects: 1, bytes: 50 },
    ]);
  });

  test("对象画像分页超时后保留已扫描结果", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const fakeFetch = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      requests += 1;
      if (requests > 1) throw new DOMException("The operation was aborted.", "AbortError");
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult>
          <IsTruncated>true</IsTruncated>
          <NextContinuationToken>next</NextContinuationToken>
          <Contents>
            <Key>knowledge/tenant-a/a.txt</Key>
            <LastModified>2026-08-01T00:00:00.000Z</LastModified>
            <Size>10</Size>
          </Contents>
        </ListBucketResult>`);
    };
    globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
    try {
      const inventory = await scanS3Objects({
        target: {
          endpoint: "http://s3.example.com",
          bucket: "bucket",
          region: "cn-beijing",
          accessKey: "access",
          secretKey: "secret",
          pathStyle: true,
        },
        prefix: "knowledge",
        maxObjects: 100_000,
        timeoutMs: 120_000,
      });
      expect(inventory).toMatchObject({
        status: "partial",
        stoppedReason: "time-limit",
        pages: 1,
        objects: 1,
        bytes: 10,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("VDB runtime config", () => {
  test("从标准 OPENSEARCH env 读取连接并脱敏密码", () => {
    expect(parseVdbConnection(
      "OPENSEARCH_URL=http://os:9200\nOPENSEARCH_USERNAME=u\nOPENSEARCH_PASSWORD=p\n",
    )).toMatchObject({
      type: "opensearch",
      endpoint: "http://os:9200",
      username: "u",
      password: "p",
      configSource: "container-runtime",
      configurationKind: "environment",
    });
  });

  test("endpoint userinfo 只进入执行态凭据，脱敏投影不泄漏", () => {
    const connection = parseVdbConnection(
      "OPENSEARCH_URL=https://embedded:top-secret@os.example:9200\n",
    );
    expect(connection).toMatchObject({
      type: "opensearch",
      endpoint: "https://os.example:9200",
      username: "embedded",
      password: "top-secret",
    });
    expect(JSON.stringify(sanitizeVdbConnection(connection))).not.toContain("top-secret");
  });
});

describe("OpenSearch VDB probe", () => {
  test("采集六类只读证据并解析实时水位、写保护、容量与 shard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-vdb-test-"));
    const outcomes = [
      "cluster-health",
      "node-allocation",
      "cluster-stats",
      "shard-state",
      "cluster-settings",
      "index-write-blocks",
    ]
      .map((id) => ({ id, title: id, risk: "observe" as const }));
    const bundle = new EvidenceBundle(dir, outcomes);
    const responses: Record<string, unknown> = {
      "/_cluster/health": {
        status: "yellow",
        number_of_nodes: 3,
        number_of_data_nodes: 2,
        active_primary_shards: 10,
        active_shards: 19,
        unassigned_shards: 1,
      },
      "/_cat/allocation": [{
        node: "data-0",
        shards: "10",
        "disk.used": "950",
        "disk.avail": "50",
        "disk.total": "1000",
        "disk.percent": "95",
      }],
      "/_cluster/stats": {
        indices: {
          count: 4,
          docs: { count: 100, deleted: 3 },
          store: { size_in_bytes: 950 },
          shards: { total: 20, primaries: 10 },
        },
      },
      "/_cat/shards": [
        { state: "STARTED", prirep: "p" },
        { state: "UNASSIGNED", prirep: "r" },
      ],
      "/_cluster/settings": {
        persistent: {
          "cluster.routing.allocation.disk.watermark.high": "80%",
          "cluster.routing.allocation.disk.watermark.flood_stage": "90%",
        },
        defaults: {
          "cluster.routing.allocation.disk.watermark.low": "70%",
        },
      },
      "/_all/_settings": {
        "blocked-index": {
          settings: { "index.blocks.read_only_allow_delete": "true" },
        },
      },
    };
    const search: OpenSearchReadApi = {
      count: async () => 0,
      search: async () => ({}),
      request: async (path) => responses[path],
    };

    const facts: VdbInspectionFacts = {
      execution: { status: "collected", namespace: "ns", pod: "kb-0" },
      configuration: {
        status: "collected",
        type: "opensearch",
        backend: "opensearch",
        store: "opensearch",
        configSource: "container-runtime",
        configurationKind: "environment",
      },
      access: { status: "collected", backend: "opensearch", channel: "direct" },
    };
    const ctx = {
      command: new CommandContext({}),
      config: {} as VdbConfig,
      executor: {
        run: async () => { throw new Error("not used"); },
        exec: async () => { throw new Error("not used"); },
      },
      execTarget: { pod: "kb-0" },
      kube: { namespace: "ns" },
      bundle,
      search,
      log: () => {},
    } satisfies VdbCommandContext;
    const collected = await runProbes(
      makeVdbProbes(),
      ctx,
      facts,
      {} as VdbConfig,
    );
    const observations = groupVdbObservations(collected);

    expect(observations.health?.status).toBe("yellow");
    expect(observations.allocation?.nodes[0]?.diskPercent).toBe(95);
    expect(observations.stats?.documents).toBe(100);
    expect(observations.shards?.unassignedReplica).toBe(1);
    expect(observations.diskSettings?.high.raw).toBe("80%");
    expect(observations.indexBlocks?.readOnlyAllowDelete).toEqual(["blocked-index"]);
    expect(bundle.getSteps().every((step) => step.status === "ok")).toBe(true);
    expect(readFileSync(join(dir, bundle.getSteps()[0]!.raw_file!), "utf8")).toContain('"status": "yellow"');
  });
});

test("detector 区分容量偏高、flood-stage 与 primary shard 故障", () => {
  const observations: VdbObservations = {
    health: {
      id: "vdb-health",
      kind: "opensearch-health",
      status: "red",
      nodes: 2,
      dataNodes: 1,
      activePrimaryShards: 2,
      activeShards: 2,
      unassignedShards: 1,
      initializingShards: 0,
      relocatingShards: 0,
      pendingTasks: 0,
    },
    allocation: {
      id: "vdb-allocation",
      kind: "opensearch-allocation",
      nodes: [{ node: "data-0", shards: 2, diskPercent: 96 }],
    },
    diskSettings: {
      id: "vdb-disk-settings",
      kind: "opensearch-disk-settings",
      low: { raw: "70%", kind: "used-ratio", usedRatio: 0.7 },
      high: { raw: "80%", kind: "used-ratio", usedRatio: 0.8 },
      floodStage: { raw: "90%", kind: "used-ratio", usedRatio: 0.9 },
      source: "cluster-settings",
    },
    indexBlocks: {
      id: "vdb-index-blocks",
      kind: "opensearch-index-blocks",
      readOnlyAllowDelete: ["idx"],
    },
    shards: {
      id: "vdb-shards",
      kind: "opensearch-shards",
      total: 3,
      unassigned: 1,
      unassignedPrimary: 1,
      unassignedReplica: 0,
    },
    missing: [],
  };
  const kinds = detectVdbFindings(observations).map((finding) => finding.kind);
  expect(kinds).toContain("vdb.cluster-red");
  expect(kinds).toContain("vdb.disk-capacity-exhausted");
  expect(kinds).toContain("vdb.index-write-blocked");
  expect(kinds).toContain("vdb.unassigned-primary-shards");
  expect(vdbCapacityConclusion(observations)).toContain("写入已受限");
});
