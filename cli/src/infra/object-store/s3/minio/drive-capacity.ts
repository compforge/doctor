import type { S3DriveCapacityResult, S3ProviderConnection } from "../provider";
import {
  parsePrometheusSample,
  prometheusLabel,
  requestMinioMetrics,
} from "./metrics";

export const MINIO_MINIMUM_FREE_INODES = 1_000;
export const MINIO_MAXIMUM_RAW_USAGE_PERCENT = 99;

interface PartialDriveCapacity {
  drive: string;
  server?: string;
  totalBytes?: number;
  usedBytes?: number;
  totalInodes?: number;
  usedInodes?: number;
}

const DRIVE_METRICS = new Set([
  "minio_node_drive_total_bytes",
  "minio_node_drive_used_bytes",
  "minio_node_drive_total_inodes",
  "minio_node_drive_used_inodes",
]);

/** Parse the stable MinIO v2 resource metrics into the per-drive write-capacity facts used by Collect. */
export function parseMinioDriveCapacityMetrics(metrics: string): S3DriveCapacityResult["drives"] {
  const rows = new Map<string, PartialDriveCapacity>();
  for (const line of metrics.split("\n")) {
    const sample = parsePrometheusSample(line);
    if (!sample || !DRIVE_METRICS.has(sample.metric)) continue;
    const drive = prometheusLabel(sample.labels, "drive");
    if (!drive) continue;
    const server = prometheusLabel(sample.labels, "server");
    const key = `${server ?? ""}\0${drive}`;
    const row = rows.get(key) ?? { drive, server };
    if (sample.metric === "minio_node_drive_total_bytes") row.totalBytes = sample.value;
    if (sample.metric === "minio_node_drive_used_bytes") row.usedBytes = sample.value;
    if (sample.metric === "minio_node_drive_total_inodes") row.totalInodes = sample.value;
    if (sample.metric === "minio_node_drive_used_inodes") row.usedInodes = sample.value;
    rows.set(key, row);
  }
  return [...rows.values()].flatMap((row) => {
    if (
      row.totalBytes === undefined
      || row.usedBytes === undefined
      || row.totalInodes === undefined
      || row.usedInodes === undefined
      || row.totalBytes <= 0
      || row.totalInodes <= 0
    ) return [];
    return [{
      drive: row.drive,
      server: row.server,
      totalBytes: row.totalBytes,
      usedBytes: row.usedBytes,
      freeBytes: Math.max(0, row.totalBytes - row.usedBytes),
      totalInodes: row.totalInodes,
      usedInodes: row.usedInodes,
      freeInodes: Math.max(0, row.totalInodes - row.usedInodes),
    }];
  }).sort((left, right) => left.drive.localeCompare(right.drive));
}

export async function getMinioDriveCapacity(
  connection: S3ProviderConnection,
  timeoutMs = 10_000,
): Promise<S3DriveCapacityResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const metrics = await requestMinioMetrics({
      endpoint: connection.endpoint,
      path: "/minio/v2/metrics/resource",
      credentials: connection.credentials,
      signal: controller.signal,
    });
    if (metrics.status < 200 || metrics.status >= 300) {
      throw new Error(`MinIO Drive Capacity Metrics 不可用：${metrics.endpoint}=HTTP ${metrics.status}`);
    }
    const drives = parseMinioDriveCapacityMetrics(metrics.body);
    if (!drives.length) {
      throw new Error(`MinIO Drive Capacity Metrics 不可用：${metrics.endpoint}=无完整 drive byte/inode 指标`);
    }
    return {
      endpoint: metrics.endpoint,
      minimumFreeInodes: MINIO_MINIMUM_FREE_INODES,
      maximumRawUsagePercent: MINIO_MAXIMUM_RAW_USAGE_PERCENT,
      drives,
    };
  } finally {
    clearTimeout(timer);
  }
}
