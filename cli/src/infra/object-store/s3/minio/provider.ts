import type { S3ProviderAdapter, S3ProviderConnection } from "../provider";
import { inspectMinioPhysicalCapacity } from "./capacity";
import { getMinioDriveCapacity } from "./drive-capacity";
import { getMinioBucketUsage } from "./usage";

async function httpStatus(connection: S3ProviderConnection, path: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    return (await connection.http.request(path, { signal: controller.signal })).status;
  } finally {
    clearTimeout(timer);
  }
}

async function inspectMinio(connection: S3ProviderConnection): Promise<string | undefined> {
  return await httpStatus(connection, "/minio/health/live") === 200
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
      Object.entries(paths).map(async ([name, path]) => {
        try { return [name, await httpStatus(connection, path)] as const; }
        catch { return [name, undefined] as const; }
      }),
    );
    return { endpoints: Object.fromEntries(entries) };
  },
  bucketUsage: async (connection) => getMinioBucketUsage(connection),
  driveCapacity: getMinioDriveCapacity,
  physicalCapacity: inspectMinioPhysicalCapacity,
};
