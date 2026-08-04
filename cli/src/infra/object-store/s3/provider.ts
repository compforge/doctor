import type { ExecResult } from "../../k8s/executor";
import { S3_PROVIDER as BUILT_IN_PROVIDER } from "./minio/provider";

export interface S3ProviderConnection {
  endpoint: string;
  credentials?: {
    accessKey: string;
    secretKey: string;
  };
}

export interface S3ProviderCapabilities {
  health: boolean;
  bucketUsage: boolean;
  physicalCapacity: boolean;
}

export interface S3ProviderInspection {
  providerId: string;
  displayName: string;
  detection: string;
  capabilities: S3ProviderCapabilities;
}

export interface S3ProviderHealth {
  endpoints: Record<string, number | undefined>;
}

export interface S3BucketUsage {
  bucket: string;
  bytes: number;
  objects?: number;
  sinceLastUpdateSeconds?: number;
}

export interface S3BucketUsageResult {
  endpoint: string;
  buckets: S3BucketUsage[];
}

export interface S3PhysicalCapacity {
  providerId: string;
  title: string;
  healthStatus?: string;
  onlineUnits?: number;
  rawCapacityBytes: number;
  rawUsageBytes: number;
  rawFreeBytes: number;
  rawUsagePercent: number;
}

export type S3ProviderCapacityResult =
  | { status: "collected"; capacity: S3PhysicalCapacity; captures: ExecResult[] }
  | { status: "unavailable" | "failed"; reason: string; captures: ExecResult[] };

export interface S3ProviderCapacityInput {
  endpoint: URL;
  kubernetes: {
    namespace: string;
    kubeconfig?: string;
    context?: string;
  };
}

/** Provider adapters only add vendor extensions; normal bucket/object access always uses the AWS S3-compatible API. */
export interface S3ProviderAdapter {
  id: string;
  displayName: string;
  inspect(connection: S3ProviderConnection): Promise<string | undefined>;
  health?: (connection: S3ProviderConnection) => Promise<S3ProviderHealth>;
  bucketUsage?: (connection: S3ProviderConnection) => Promise<S3BucketUsageResult>;
  physicalCapacity?: (input: S3ProviderCapacityInput) => Promise<S3ProviderCapacityResult>;
}

const PROVIDERS: readonly S3ProviderAdapter[] = [BUILT_IN_PROVIDER];

function provider(providerId: string): S3ProviderAdapter {
  const matched = PROVIDERS.find((candidate) => candidate.id === providerId);
  if (!matched) throw new Error(`S3 Provider Adapter '${providerId}' 未注册`);
  return matched;
}

export async function inspectS3Provider(connection: S3ProviderConnection): Promise<S3ProviderInspection> {
  for (const adapter of PROVIDERS) {
    const detection = await adapter.inspect(connection);
    if (!detection) continue;
    return {
      providerId: adapter.id,
      displayName: adapter.displayName,
      detection,
      capabilities: {
        health: !!adapter.health,
        bucketUsage: !!adapter.bucketUsage,
        physicalCapacity: !!adapter.physicalCapacity,
      },
    };
  }
  return {
    providerId: "generic-s3",
    displayName: "S3 Compatible",
    detection: "s3-api",
    capabilities: { health: false, bucketUsage: false, physicalCapacity: false },
  };
}

export async function getS3ProviderHealth(
  providerId: string,
  connection: S3ProviderConnection,
): Promise<S3ProviderHealth> {
  const operation = provider(providerId).health;
  if (!operation) throw new Error(`S3 Provider '${providerId}' 不提供 health 能力`);
  return operation(connection);
}

export async function getS3ProviderBucketUsage(
  providerId: string,
  connection: S3ProviderConnection,
): Promise<S3BucketUsageResult> {
  const operation = provider(providerId).bucketUsage;
  if (!operation) throw new Error(`S3 Provider '${providerId}' 不提供 bucket usage 能力`);
  return operation(connection);
}

export async function getS3ProviderPhysicalCapacity(
  providerId: string,
  input: S3ProviderCapacityInput,
): Promise<S3ProviderCapacityResult> {
  const operation = provider(providerId).physicalCapacity;
  if (!operation) throw new Error(`S3 Provider '${providerId}' 不提供 physical capacity 能力`);
  return operation(input);
}
