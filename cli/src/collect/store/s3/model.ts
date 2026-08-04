import type { Diagnosis, Evidence, FindingMeta } from "../../protocol";
import type { S3InventorySummary } from "../s3-inventory";
import type { S3InspectionFacts } from "./fact/model";

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
export interface S3BucketAccessObservation {
  id: "s3-bucket-access";
  kind: "s3-bucket-access";
  ok: boolean;
  httpStatus: number;
  buckets: string[];
  discovery: "list-buckets" | "configured-bucket-fallback";
  discoveryReason?: string;
}
export interface S3BucketInventory extends S3InventorySummary {
  bucket: string;
  serviceFocus: boolean;
  focusPrefix?: string;
  versioning: "enabled" | "suspended" | "disabled" | "unavailable";
  versioningReason?: string;
}
export interface S3InventoryObservation {
  id: "s3-object-inventory";
  kind: "s3-object-inventory";
  buckets: S3BucketInventory[];
  discoveredBuckets: number;
  scannedBuckets: number;
}
export interface S3BucketUsageObservation {
  id: "s3-bucket-usage";
  kind: "s3-bucket-usage";
  providerId: string;
  providerDisplayName: string;
  metricsEndpoint: string;
  buckets: Array<{
    bucket: string;
    bytes: number;
    objects?: number;
    sinceLastUpdateSeconds?: number;
  }>;
}
export interface S3ProviderHealthObservation {
  id: "s3-provider-health";
  kind: "s3-provider-health";
  providerId: string;
  providerDisplayName: string;
  endpoints: Record<string, number | undefined>;
}
export interface S3CapacityObservation extends S3PhysicalCapacity {
  id: "s3-capacity";
  kind: "s3-capacity";
}
export type S3Observation = S3BucketAccessObservation | S3InventoryObservation | S3BucketUsageObservation | S3ProviderHealthObservation | S3CapacityObservation;
export interface S3Observations {
  bucketAccess?: S3BucketAccessObservation;
  inventory?: S3InventoryObservation;
  bucketUsage?: S3BucketUsageObservation;
  providerHealth?: S3ProviderHealthObservation;
  capacity?: S3CapacityObservation;
}
export type S3FindingKind = `s3.${string}`;
export interface S3Finding extends FindingMeta<S3FindingKind> { summary: string; [key: string]: unknown }
export type S3DiagnosisGoal = "bucket-access" | "object-inventory" | "provider-health" | "capacity";
export type S3Evidence = Evidence<S3Observation, S3InspectionFacts>;
export type S3Diagnosis = Diagnosis<S3Evidence, S3Finding, S3DiagnosisGoal>;

export function groupS3Observations(observations: readonly S3Observation[]): S3Observations {
  const find = <Kind extends S3Observation["kind"]>(kind: Kind) =>
    observations.find((item) => item.kind === kind) as Extract<S3Observation, { kind: Kind }> | undefined;
  return {
    bucketAccess: find("s3-bucket-access"),
    inventory: find("s3-object-inventory"),
    bucketUsage: find("s3-bucket-usage"),
    providerHealth: find("s3-provider-health"),
    capacity: find("s3-capacity"),
  };
}
