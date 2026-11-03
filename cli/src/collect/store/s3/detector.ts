import { evidenceGaps, type EvidenceGapFinding } from "../../evidence-gaps";
import type { Detector, } from "../../protocol";
import type { S3Evidence, S3Finding, S3PhysicalCapacity } from "./model";
import { groupS3Observations } from "./model";

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "s3-health" },
};

export function detectS3CapacityFinding(capacity: S3PhysicalCapacity): Record<string, unknown> | undefined {
  if (capacity.rawUsagePercent >= 90) {
    return { severity: "critical", kind: "s3.capacity-exhausted", usagePercent: capacity.rawUsagePercent };
  }
  if (capacity.rawUsagePercent >= 80) {
    return { severity: "warning", kind: "s3.capacity-high", usagePercent: capacity.rawUsagePercent };
  }
  return undefined;
}

function finding(input: {
  id: string;
  kind: `s3.${string}`;
  severity: "warning" | "critical";
  observationId: string;
  summary: string;
  detail?: Record<string, unknown>;
}): S3Finding {
  return {
    ...FINDING_META,
    ...input.detail,
    id: input.id,
    kind: input.kind,
    severity: input.severity,
    confidence: "high",
    evidence: [{ observationId: input.observationId, role: "supporting" }],
    summary: input.summary,
  };
}

export function detectS3Findings(evidence: S3Evidence): S3Finding[] {
  const observations = groupS3Observations(evidence.observations);
  const findings: S3Finding[] = [];
  if (observations.bucketAccess && !observations.bucketAccess.ok) {
    findings.push(finding({
      id: "s3-bucket-unreachable",
      kind: "s3.bucket-unreachable",
      severity: "critical",
      observationId: observations.bucketAccess.id,
      summary: `HeadBucket 返回 HTTP ${observations.bucketAccess.httpStatus}。`,
      detail: { httpStatus: observations.bucketAccess.httpStatus },
    }));
  }
  if (observations.providerHealth) {
    for (const [name, status] of Object.entries(observations.providerHealth.endpoints)) {
      if (status === 200) continue;
      findings.push(finding({
        id: `s3-provider-${name}-unhealthy`,
        kind: `s3.provider-${name}-unhealthy`,
        severity: "critical",
        observationId: observations.providerHealth.id,
        summary: `${observations.providerHealth.providerDisplayName} ${name} health endpoint 返回 ${status ?? "no response"}。`,
        detail: { httpStatus: status },
      }));
    }
  }
  if (observations.capacity) {
    const capacityFinding = detectS3CapacityFinding(observations.capacity);
    if (capacityFinding) {
      const kind = capacityFinding.kind as `s3.${string}`;
      findings.push(finding({
        id: kind.replaceAll(".", "-"),
        kind,
        severity: capacityFinding.severity as "warning" | "critical",
        observationId: observations.capacity.id,
        summary: `对象存储物理容量使用率为 ${observations.capacity.rawUsagePercent.toFixed(1)}%。`,
        detail: { usagePercent: observations.capacity.rawUsagePercent },
      }));
    }
    if (observations.capacity.healthStatus && observations.capacity.healthStatus.toLowerCase() !== "green") {
      findings.push(finding({
        id: "s3-provider-capacity-unhealthy",
        kind: "s3.provider-capacity-unhealthy",
        severity: "critical",
        observationId: observations.capacity.id,
        summary: `${observations.capacity.title} health 为 ${observations.capacity.healthStatus}。`,
        detail: { healthStatus: observations.capacity.healthStatus },
      }));
    }
  }
  if (observations.driveCapacity) {
    const driveCapacity = observations.driveCapacity;
    const inodeExhausted = driveCapacity.drives.filter(
      (drive) => drive.freeInodes < driveCapacity.minimumFreeInodes,
    );
    const totalBytes = driveCapacity.drives.reduce((sum, drive) => sum + drive.totalBytes, 0);
    const usedBytes = driveCapacity.drives.reduce((sum, drive) => sum + drive.usedBytes, 0);
    const rawUsagePercent = totalBytes > 0 ? usedBytes / totalBytes * 100 : 0;
    const byteThresholdReached = rawUsagePercent >= driveCapacity.maximumRawUsagePercent;
    if (inodeExhausted.length || byteThresholdReached) {
      const reasons = [
        ...(inodeExhausted.length
          ? [`${inodeExhausted.length}/${driveCapacity.drives.length} 块盘 free inode 低于 ${driveCapacity.minimumFreeInodes}`]
          : []),
        ...(byteThresholdReached
          ? [`逐盘 raw 使用率合计 ${rawUsagePercent.toFixed(1)}%`]
          : []),
      ];
      findings.push(finding({
        id: "s3-minio-storage-full",
        kind: "s3.minio-storage-full",
        severity: "critical",
        observationId: driveCapacity.id,
        summary: `${driveCapacity.providerDisplayName} 已达到写入保护阈值：${reasons.join("；")}，写入可能返回 XMinioStorageFull。`,
        detail: {
          affectedDrives: inodeExhausted.map((drive) => drive.drive),
          minimumFreeInodes: driveCapacity.minimumFreeInodes,
          rawUsagePercent,
        },
      }));
    }
  }
  const inventory = observations.inventory;
  const versionedBuckets = inventory?.buckets
    .filter((bucket) => bucket.versioning === "enabled")
    .map((bucket) => bucket.bucket) ?? [];
  if (versionedBuckets.length) {
    findings.push(finding({
      id: "s3-versioning-enabled",
      kind: "s3.versioning-enabled",
      severity: "warning",
      observationId: inventory!.id,
      summary: `Bucket ${versionedBuckets.join("、")} 已开启 versioning；删除当前对象可能只产生 delete marker，旧版本仍会占用空间。`,
    }));
  }
  return findings;
}

export const s3Detectors: readonly Detector<S3Evidence, S3Finding>[] = [detectS3Findings];

export function detectS3EvidenceGaps(evidence: S3Evidence): EvidenceGapFinding[] {
  const observations = groupS3Observations(evidence.observations);
  const accessReason = evidence.facts.access.status === "collected" ? undefined : evidence.facts.access.reason;
  const missing = (goal: string, present: boolean, label: string, optional = false) => (evidenceGaps(goal, present ? [] : [accessReason ?? `${label} 未取得`], evidence));
  const bucketAccess = observations.bucketAccess;
  const inventory = observations.inventory;
  const inventoryComplete = !!inventory
    && inventory.scannedBuckets === inventory.discoveredBuckets
    && inventory.buckets.every((bucket) => bucket.status === "complete");
  return [
    ...(bucketAccess
      ? evidenceGaps("bucket-access", bucketAccess.discoveryReason ? [bucketAccess.discoveryReason] : [], evidence)
      : missing("bucket-access", false, "ListBuckets / HeadBucket 结果")),
    ...(inventory
      ? evidenceGaps("object-inventory", inventoryComplete ? [] : [
            `已扫描 ${inventory.scannedBuckets}/${inventory.discoveredBuckets} 个 Bucket；部分对象画像受时间或对象数预算限制`,
          ], evidence)
      : missing("object-inventory", false, "对象画像")),
    ...missing("provider-health", !!observations.providerHealth, "provider health API", true),
    ...missing("drive-capacity", !!observations.driveCapacity, "provider drive capacity metrics", true),
    ...missing("capacity", !!observations.capacity, "对象存储物理容量", true),
  ];
}
