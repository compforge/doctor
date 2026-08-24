import {
  parsePrometheusSample,
  prometheusLabel,
  requestMinioMetrics,
  type MinioMetricsCredentials,
} from "./metrics";

export interface MinioBucketUsage {
  bucket: string;
  bytes: number;
  objects?: number;
  sinceLastUpdateSeconds?: number;
}

export interface MinioBucketUsageResult {
  endpoint: string;
  buckets: MinioBucketUsage[];
}

const TOTAL_BYTES = new Set([
  "minio_cluster_usage_buckets_total_bytes",
  "minio_bucket_usage_total_bytes",
]);
const OBJECTS_COUNT = new Set([
  "minio_cluster_usage_buckets_objects_count",
  "minio_bucket_usage_object_total",
]);
const UPDATE_AGE = new Set([
  "minio_cluster_usage_buckets_since_last_update_seconds",
  "minio_bucket_usage_since_last_update_seconds",
]);

/** Parse the MinIO v3 bucket usage family without coupling collection code to Prometheus text. */
export function parseMinioBucketUsageMetrics(metrics: string): MinioBucketUsage[] {
  const rows = new Map<string, MinioBucketUsage>();
  for (const rawLine of metrics.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sample = parsePrometheusSample(line);
    if (!sample) continue;
    const { metric, labels, value } = sample;
    if (!TOTAL_BYTES.has(metric) && !OBJECTS_COUNT.has(metric) && !UPDATE_AGE.has(metric)) continue;
    const bucket = prometheusLabel(labels, "bucket");
    if (!bucket) continue;
    const row = rows.get(bucket) ?? { bucket, bytes: 0 };
    if (TOTAL_BYTES.has(metric)) row.bytes = value;
    if (OBJECTS_COUNT.has(metric)) row.objects = value;
    if (UPDATE_AGE.has(metric)) row.sinceLastUpdateSeconds = value;
    rows.set(bucket, row);
  }
  return [...rows.values()]
    .filter((row) => row.bytes > 0 || row.objects !== undefined)
    .sort((left, right) => right.bytes - left.bytes || left.bucket.localeCompare(right.bucket));
}

export async function getMinioBucketUsage(
  endpoint: string,
  credentials?: MinioMetricsCredentials,
  timeoutMs = 10_000,
): Promise<MinioBucketUsageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const paths = [
      "/minio/metrics/v3/cluster/usage/buckets",
      "/minio/v2/metrics/bucket",
      "/minio/v2/metrics/cluster",
    ];
    const failures: string[] = [];
    for (const path of paths) {
      const response = await requestMinioMetrics({ endpoint, path, credentials, signal: controller.signal });
      if (response.status < 200 || response.status >= 300) {
        failures.push(`${path}=HTTP ${response.status}`);
        continue;
      }
      const buckets = parseMinioBucketUsageMetrics(response.body);
      if (!buckets.length) {
        const usageFamilies = [...new Set(response.body.split("\n").flatMap((line) => {
          const metric = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line.trim())?.[1];
          return metric?.includes("usage") ? [metric] : [];
        }))].slice(0, 8);
        failures.push(`${path}=无 bucket usage${usageFamilies.length ? `（${usageFamilies.join("、")}）` : ""}`);
        continue;
      }
      return { endpoint: response.endpoint, buckets };
    }
    throw new Error(`MinIO Bucket Usage Metrics 不可用：${failures.join("；")}`);
  } finally {
    clearTimeout(timer);
  }
}
