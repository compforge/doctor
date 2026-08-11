import { expect, test } from "bun:test";
import { buildRedisInspectionFacts } from "../src/collect/redis/fact/model";
import { buildRedisEvidence, type RedisDiagnosis } from "../src/collect/redis/model";
import {
  buildRedisKeyDistributionHtml,
  buildRedisPrefixKeyPieCharts,
  buildRedisPrefixMemoryPieCharts,
} from "../src/collect/redis/render";

test("Redis 前缀 Key 占比按计数 Top-N 展示并汇总其他前缀", () => {
  const facts = buildRedisInspectionFacts({
    endpoints: [["redis.example.com", 6379]],
    database: 0,
    useSsl: false,
    clusterType: "single",
    endpointSource: "service-env",
    credentialSource: "service-env",
  }, { namespace: "default", pod: "redis-0" }, { available: true });
  const evidence = buildRedisEvidence([{
    id: "keyspace:redis.example.com:6379:db0",
    kind: "keyspace",
    scan: {
      node: { host: "redis.example.com", port: 6379 },
      database: 0,
      scanned_keys: 10,
      scan_complete: false,
      sampled_memory_bytes: 1_000,
      average_sampled_bytes_per_key: 100,
      types: [],
      prefixes: [
        {
          name: "cache:*",
          count: 3,
          memory_bytes: 600,
          no_ttl_count: 0,
          no_ttl_memory_bytes: 0,
        },
        {
          name: "session:*",
          count: 5,
          memory_bytes: 300,
          no_ttl_count: 0,
          no_ttl_memory_bytes: 0,
        },
      ],
      top_prefixes_by_key_count: [
        { name: "session:*", count: 5 },
        { name: "cache:*", count: 3 },
      ],
      ttl_buckets: {},
      top_slots: [],
      top_keys: [],
      top_streams: [],
    },
  }], facts);
  const diagnosis: RedisDiagnosis = { evidence, findings: [], coverage: [] };

  expect(buildRedisPrefixKeyPieCharts(diagnosis)).toEqual([{
    title: "redis.example.com:6379 / db0",
    description: "按本次检查的 10 个 Key 统计；前缀取第一个冒号前的内容，未进入 Top-N 的 Key 汇总为其他前缀。",
    slices: [
      { label: "session:*", value: 5 },
      { label: "cache:*", value: 3 },
      { label: "其他前缀", value: 2 },
    ],
  }]);

  expect(buildRedisPrefixMemoryPieCharts(diagnosis)).toEqual([{
    title: "redis.example.com:6379 / db0",
    description: "按本次检查 Key 的 1000 B 内存统计；未进入内存 Top-N 的 Key 汇总为其他前缀。",
    slices: [
      { label: "cache:*", value: 600, valueLabel: "600 B" },
      { label: "session:*", value: 300, valueLabel: "300 B" },
      { label: "其他前缀", value: 100, valueLabel: "100 B" },
    ],
  }]);
});

test("Redis Key 分布对同一 master 的多个 DB 使用独立 DB 下拉框", () => {
  const facts = buildRedisInspectionFacts({
    endpoints: [["redis.example.com", 6379]],
    database: 7,
    useSsl: false,
    clusterType: "single",
    endpointSource: "service-env",
    credentialSource: "service-env",
  }, { namespace: "default", pod: "redis-0" }, { available: true });
  const scans = [0, 7].map((database) => ({
    id: `keyspace:redis.example.com:6379:db${database}`,
    kind: "keyspace" as const,
    scan: {
      node: { host: "redis.example.com", port: 6379 },
      database,
      scanned_keys: 1,
      scan_complete: true,
      sampled_memory_bytes: 100,
      average_sampled_bytes_per_key: 100,
      types: [],
      prefixes: [],
      top_prefixes_by_key_count: [],
      ttl_buckets: {},
      top_slots: [],
      top_keys: [],
      top_streams: [],
    },
  }));
  const diagnosis: RedisDiagnosis = {
    evidence: buildRedisEvidence(scans, facts),
    findings: [],
    coverage: [],
  };

  const html = buildRedisKeyDistributionHtml(diagnosis);
  expect(html).toContain("<label>DB <select");
  expect(html).toContain(">db0</option>");
  expect(html).toContain(">db7</option>");
  expect(html).not.toContain("<label>Master <select");
});
