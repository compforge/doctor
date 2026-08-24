import type { S3ProviderAdapter, S3ProviderConnection } from "../provider";
import { inspectMinioPhysicalCapacity } from "./capacity";
import { getMinioDriveCapacity } from "./drive-capacity";
import { getMinioBucketUsage } from "./usage";

async function httpStatus(endpoint: string, path: string): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const url = new URL(path, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    return (await fetch(url, { signal: controller.signal })).status;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function inspectMinio(connection: S3ProviderConnection): Promise<string | undefined> {
  return await httpStatus(connection.endpoint, "/minio/health/live") === 200
    ? "minio-health-api"
    : undefined;
}

export const S3_PROVIDER: S3ProviderAdapter = {
  id: "minio",
  displayName: "MinIO",
  inspect: inspectMinio,
  health: async (connection) => {
    const paths = {
      live: "/minio/health/live",
      ready: "/minio/health/ready",
      writeQuorum: "/minio/health/cluster?distributed=true",
      readQuorum: "/minio/health/cluster/read?distributed=true",
    } as const;
    const entries = await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await httpStatus(connection.endpoint, path)] as const),
    );
    return { endpoints: Object.fromEntries(entries) };
  },
  bucketUsage: async (connection) => getMinioBucketUsage(connection.endpoint, connection.credentials),
  driveCapacity: getMinioDriveCapacity,
  physicalCapacity: inspectMinioPhysicalCapacity,
};
