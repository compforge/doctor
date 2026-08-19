import type { ExecResult } from "../../../infra/k8s/executor";
import {
  getBucketVersioning,
  getS3ProviderBucketUsage,
  getS3ProviderHealth,
  getS3ProviderPhysicalCapacity,
  headBucket,
  listBuckets,
} from "../../../infra/object-store";
import { terminalStdout } from "../../../terminal/output";
import type { Probe } from "../../protocol";
import { PROBE_RUNNABLE, probeUnavailable } from "../../protocol";
import type { StoreConfig } from "../config";
import { scanS3Objects } from "../s3-inventory";
import type { S3CommandContext } from "./context";
import type { S3InspectionFacts } from "./fact/model";
import type { S3Observation } from "./model";

type S3Probe = Probe<S3Observation, S3InspectionFacts, StoreConfig, S3CommandContext>;

function accessEvaluation(facts: S3InspectionFacts) {
  return facts.access.status === "collected" ? PROBE_RUNNABLE : probeUnavailable(facts.access.reason);
}

function capabilityEvaluation(capability: "health" | "bucketUsage" | "physicalCapacity") {
  return (facts: S3InspectionFacts) => {
  if (facts.provider.status !== "collected") return probeUnavailable(facts.provider.reason);
    return facts.provider.capabilities[capability]
    ? PROBE_RUNNABLE
      : probeUnavailable(`${facts.provider.displayName} Provider Adapter 不提供 ${capability} 能力`);
  };
}

function unavailable(outcome: string) {
  return (ctx: S3CommandContext, reason: string) => ctx.bundle.fill(outcome, { status: "unavailable", reason });
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordCapacityCaptures(ctx: S3CommandContext, captures: readonly ExecResult[]): void {
  for (const [index, capture] of captures.entries()) {
    ctx.bundle.addStep({
      id: `s3-capacity-source-${index + 1}`,
      title: "读取对象存储 provider 容量",
      risk: "observe",
      status: capture.ok ? "ok" : "failed",
      reason: capture.ok ? undefined : capture.stderr.trim().split("\n")[0] || `exit=${capture.exitCode}`,
      command: capture.command,
      exitCode: capture.exitCode,
      durationMs: capture.durationMs,
    });
  }
}

const BUCKET_ACCESS_PROBE: S3Probe = {
  id: "bucket-access",
  evaluate: accessEvaluation,
  onUnavailable: unavailable("bucket-access"),
  run: async (ctx) => {
    try {
      let buckets: string[];
      let discovery: "list-buckets" | "configured-bucket-fallback" = "list-buckets";
      let discoveryReason: string | undefined;
      let httpStatus = 200;
      try {
        buckets = (await listBuckets({ ...ctx.target!, endpoint: ctx.preparedEndpoint! })).buckets;
      } catch (error) {
        discovery = "configured-bucket-fallback";
        discoveryReason = errorReason(error);
        const access = await headBucket({ ...ctx.target!, endpoint: ctx.preparedEndpoint! });
        httpStatus = access.status;
        if (!access.ok) throw error;
        buckets = [ctx.target!.bucket];
      }
      if (!buckets.includes(ctx.target!.bucket)) buckets.unshift(ctx.target!.bucket);
      ctx.accessibleBuckets = [...new Set(buckets)];
      const observation = {
        id: "s3-bucket-access" as const,
        kind: "s3-bucket-access" as const,
        ok: true,
        httpStatus,
        buckets: ctx.accessibleBuckets,
        discovery,
        discoveryReason,
      };
      ctx.bundle.fill("bucket-access", {
        status: "ok",
        reason: discoveryReason,
        output: `${JSON.stringify(observation, null, 2)}\n`,
        ext: "json",
      });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("bucket-access", { status: "failed", reason: errorReason(error) });
      return [];
    }
  },
};

const INVENTORY_PROBE: S3Probe = {
  id: "object-inventory",
  evaluate: accessEvaluation,
  onUnavailable: unavailable("object-inventory"),
  run: async (ctx, _facts, config) => {
    try {
      const discovered = ctx.accessibleBuckets ?? [ctx.target!.bucket];
      const usage = new Map((ctx.bucketUsage ?? []).map((row) => [row.bucket, row.bytes]));
      const buckets = [...discovered].sort((left, right) => {
        if (left === ctx.serviceBucket) return -1;
        if (right === ctx.serviceBucket) return 1;
        return (usage.get(right) ?? 0) - (usage.get(left) ?? 0) || left.localeCompare(right);
      });
      const deadline = Date.now() + config.s3ScanTimeoutMs;
      let remainingObjects = config.s3MaxObjects;
      const inventories = [];
      terminalStdout.write(`[collect] 扫描 ${buckets.length} 个 S3 Bucket 的对象 metadata：最多 ${config.s3MaxObjects} 个对象 / ${config.s3ScanTimeoutMs / 1000}s\n`);
      for (const [index, bucket] of buckets.entries()) {
        const remainingBuckets = buckets.length - index;
        const remainingMs = deadline - Date.now();
        if (remainingObjects <= 0 || remainingMs <= 0) break;
        const serviceFocus = bucket === ctx.serviceBucket;
        const objectBudget = Math.max(1, Math.floor(
          serviceFocus && remainingBuckets > 1 ? remainingObjects / 2 : remainingObjects / remainingBuckets,
        ));
        const timeBudget = Math.max(1, Math.floor(
          serviceFocus && remainingBuckets > 1 ? remainingMs / 2 : remainingMs / remainingBuckets,
        ));
        terminalStdout.write(`[collect] 扫描 Bucket ${index + 1}/${buckets.length}：${bucket}${serviceFocus && ctx.servicePrefix ? `（优先 Prefix ${ctx.servicePrefix}）` : ""}\n`);
        const target = { ...ctx.target!, endpoint: ctx.preparedEndpoint!, bucket };
        let versioning: "enabled" | "suspended" | "disabled" | "unavailable" = "unavailable";
        let versioningReason: string | undefined;
        try {
          versioning = await getBucketVersioning(target);
        } catch (error) {
          versioningReason = errorReason(error);
        }
        const inventory = await scanS3Objects({
          target,
          prefix: ctx.inventoryPrefix,
          priorityPrefix: serviceFocus ? ctx.servicePrefix : undefined,
          maxObjects: objectBudget,
          timeoutMs: timeBudget,
          onProgress: (objects, pages) => {
            if (pages === 1 || pages % 10 === 0) terminalStdout.write(`[collect] ${bucket}：已扫描 ${objects} 个对象（${pages} pages）\n`);
          },
        });
        remainingObjects -= inventory.objects;
        inventories.push({
          bucket,
          serviceFocus,
          focusPrefix: serviceFocus ? ctx.servicePrefix : undefined,
          ...inventory,
          versioning,
          versioningReason,
        });
      }
      const observation = {
        id: "s3-object-inventory" as const,
        kind: "s3-object-inventory" as const,
        buckets: inventories,
        discoveredBuckets: buckets.length,
        scannedBuckets: inventories.length,
      };
      ctx.bundle.fill("object-inventory", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("object-inventory", { status: "failed", reason: errorReason(error) });
      return [];
    }
  },
};

const PROVIDER_HEALTH_PROBE: S3Probe = {
  id: "provider-health",
  evaluate: capabilityEvaluation("health"),
  onUnavailable: unavailable("provider-health"),
  run: async (ctx, facts) => {
    const provider = facts.provider;
    if (provider.status !== "collected") return [];
    const health = await getS3ProviderHealth(provider.providerId, {
      endpoint: ctx.preparedEndpoint!,
      credentials: { accessKey: ctx.target!.accessKey, secretKey: ctx.target!.secretKey },
    });
    const observation = {
      id: "s3-provider-health" as const,
      kind: "s3-provider-health" as const,
      providerId: provider.providerId,
      providerDisplayName: provider.displayName,
      endpoints: health.endpoints,
    };
    ctx.bundle.fill("provider-health", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
    return [observation];
  },
};

const BUCKET_USAGE_PROBE: S3Probe = {
  id: "bucket-usage",
  evaluate: capabilityEvaluation("bucketUsage"),
  onUnavailable: unavailable("bucket-usage"),
  run: async (ctx, facts) => {
    try {
      const provider = facts.provider;
      if (provider.status !== "collected") return [];
      const usage = await getS3ProviderBucketUsage(provider.providerId, {
        endpoint: ctx.preparedEndpoint!,
        credentials: { accessKey: ctx.target!.accessKey, secretKey: ctx.target!.secretKey },
      });
      ctx.bucketUsage = usage.buckets;
      const observation = {
        id: "s3-bucket-usage" as const,
        kind: "s3-bucket-usage" as const,
        providerId: provider.providerId,
        providerDisplayName: provider.displayName,
        metricsEndpoint: usage.endpoint,
        buckets: usage.buckets,
      };
      ctx.bundle.fill("bucket-usage", { status: "ok", output: `${JSON.stringify(observation, null, 2)}\n`, ext: "json" });
      return [observation];
    } catch (error) {
      ctx.bundle.fill("bucket-usage", { status: "unavailable", reason: errorReason(error) });
      return [];
    }
  },
};

const CAPACITY_PROBE: S3Probe = {
  id: "capacity",
  evaluate: capabilityEvaluation("physicalCapacity"),
  onUnavailable: unavailable("capacity"),
  run: async (ctx, facts) => {
    const provider = facts.provider;
    if (provider.status !== "collected") return [];
    const result = await getS3ProviderPhysicalCapacity(provider.providerId, {
      endpoint: ctx.originalEndpoint!,
      kubernetes: ctx.config.collect.kubernetes,
    });
    recordCapacityCaptures(ctx, result.captures);
    ctx.bundle.fill("capacity", {
      status: result.status === "collected" ? "ok" : result.status,
      reason: result.status === "collected" ? undefined : result.reason,
      output: result.status === "collected" ? `${JSON.stringify(result.capacity, null, 2)}\n` : undefined,
      ext: result.status === "collected" ? "json" : undefined,
    });
    return result.status === "collected"
      ? [{ id: "s3-capacity" as const, kind: "s3-capacity" as const, ...result.capacity }]
      : [];
  },
};

export function makeS3Probes(): S3Probe[] {
  return [BUCKET_ACCESS_PROBE, PROVIDER_HEALTH_PROBE, BUCKET_USAGE_PROBE, INVENTORY_PROBE, CAPACITY_PROBE];
}
