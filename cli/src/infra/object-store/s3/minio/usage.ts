import { createHmac } from "node:crypto";

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

export interface MinioMetricsCredentials {
  accessKey: string;
  secretKey: string;
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

function prometheusLabel(labels: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|,)${name}="((?:\\\\.|[^"])*)"`).exec(labels);
  return match?.[1]
    ?.replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

/** Parse the MinIO v3 bucket usage family without coupling collection code to Prometheus text. */
export function parseMinioBucketUsageMetrics(metrics: string): MinioBucketUsage[] {
  const rows = new Map<string, MinioBucketUsage>();
  for (const rawLine of metrics.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([^\s]+)(?:\s|$)/.exec(line);
    if (!match) continue;
    const [, metric, labels, rawValue] = match;
    if (!TOTAL_BYTES.has(metric!) && !OBJECTS_COUNT.has(metric!) && !UPDATE_AGE.has(metric!)) continue;
    const bucket = prometheusLabel(labels!, "bucket");
    const value = Number(rawValue);
    if (!bucket || !Number.isFinite(value) || value < 0) continue;
    const row = rows.get(bucket) ?? { bucket, bytes: 0 };
    if (TOTAL_BYTES.has(metric!)) row.bytes = value;
    if (OBJECTS_COUNT.has(metric!)) row.objects = value;
    if (UPDATE_AGE.has(metric!)) row.sinceLastUpdateSeconds = value;
    rows.set(bucket, row);
  }
  return [...rows.values()]
    .filter((row) => row.bytes > 0 || row.objects !== undefined)
    .sort((left, right) => right.bytes - left.bytes || left.bucket.localeCompare(right.bucket));
}

function prometheusBearerToken(credentials: MinioMetricsCredentials): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "HS512", typ: "JWT" }));
  const payload = encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 60 * 60,
    sub: credentials.accessKey,
    iss: "prometheus",
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha512", credentials.secretKey).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
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
      const metricsUrl = new URL(path, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
      let response = await fetch(metricsUrl, { signal: controller.signal });
      if ((response.status === 401 || response.status === 403) && credentials) {
        response = await fetch(metricsUrl, {
          headers: { authorization: `Bearer ${prometheusBearerToken(credentials)}` },
          signal: controller.signal,
        });
      }
      if (!response.ok) {
        failures.push(`${path}=HTTP ${response.status}`);
        continue;
      }
      const body = await response.text();
      const buckets = parseMinioBucketUsageMetrics(body);
      if (!buckets.length) {
        const usageFamilies = [...new Set(body.split("\n").flatMap((line) => {
          const metric = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line.trim())?.[1];
          return metric?.includes("usage") ? [metric] : [];
        }))].slice(0, 8);
        failures.push(`${path}=无 bucket usage${usageFamilies.length ? `（${usageFamilies.join("、")}）` : ""}`);
        continue;
      }
      return { endpoint: metricsUrl.pathname, buckets };
    }
    throw new Error(`MinIO Bucket Usage Metrics 不可用：${failures.join("；")}`);
  } finally {
    clearTimeout(timer);
  }
}
