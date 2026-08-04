import { KubectlExecutor } from "../../../k8s/executor";
import { serviceIdentity } from "../../../k8s/service";
import type {
  S3PhysicalCapacity,
  S3ProviderCapacityInput,
  S3ProviderCapacityResult,
} from "../provider";

interface MinioTenantStatus {
  healthStatus?: string;
  drivesOnline?: number;
  usage?: { rawCapacity?: number; rawUsage?: number };
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseMinioTenantCapacity(input: {
  namespace: string;
  tenant: string;
  status?: MinioTenantStatus;
}): S3PhysicalCapacity | undefined {
  const rawCapacityBytes = positiveNumber(input.status?.usage?.rawCapacity);
  const rawUsageBytes = positiveNumber(input.status?.usage?.rawUsage);
  if (rawCapacityBytes === undefined || rawUsageBytes === undefined || rawCapacityBytes === 0) return undefined;
  return {
    providerId: "minio",
    title: `MinIO Tenant ${input.namespace}/${input.tenant}`,
    healthStatus: input.status?.healthStatus,
    onlineUnits: positiveNumber(input.status?.drivesOnline),
    rawCapacityBytes,
    rawUsageBytes,
    rawFreeBytes: Math.max(0, rawCapacityBytes - rawUsageBytes),
    rawUsagePercent: rawUsageBytes / rawCapacityBytes * 100,
  };
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function inspectMinioPhysicalCapacity(
  input: S3ProviderCapacityInput,
): Promise<S3ProviderCapacityResult> {
  const identity = serviceIdentity(input.endpoint.hostname, input.kubernetes.namespace);
  if (!identity) {
    return {
      status: "unavailable",
      reason: "S3 endpoint 不是 Kubernetes Service，无法读取 MinIO Tenant 容量",
      captures: [],
    };
  }
  const executor = new KubectlExecutor({
    namespace: identity.namespace,
    kubeconfig: input.kubernetes.kubeconfig,
    context: input.kubernetes.context,
  });
  const service = await executor.run(["get", "service", identity.name, "-o", "json"], { timeoutMs: 20_000 });
  if (!service.ok) {
    return {
      status: "unavailable",
      reason: `无法确认 endpoint Service：${service.stderr.trim() || `exit=${service.exitCode}`}`,
      captures: [service],
    };
  }
  let tenantName: string | undefined;
  try {
    const parsed = JSON.parse(service.stdout) as { spec?: { selector?: Record<string, string> } };
    tenantName = parsed.spec?.selector?.["v1.min.io/tenant"];
  } catch {
    tenantName = undefined;
  }
  if (!tenantName) {
    return {
      status: "unavailable",
      reason: `Service '${identity.namespace}/${identity.name}' 不是 MinIO Tenant Service`,
      captures: [service],
    };
  }
  const tenant = await executor.run(["get", "tenant", tenantName, "-o", "json"], { timeoutMs: 20_000 });
  if (!tenant.ok) {
    return {
      status: "unavailable",
      reason: `读取 MinIO Tenant '${tenantName}' 失败：${tenant.stderr.trim() || `exit=${tenant.exitCode}`}`,
      captures: [service, tenant],
    };
  }
  try {
    const parsed = JSON.parse(tenant.stdout) as { status?: MinioTenantStatus };
    const capacity = parseMinioTenantCapacity({
      namespace: identity.namespace,
      tenant: tenantName,
      status: parsed.status,
    });
    return capacity
      ? { status: "collected", capacity, captures: [service, tenant] }
      : {
          status: "unavailable",
          reason: "MinIO Tenant status 未提供 rawCapacity/rawUsage",
          captures: [service, tenant],
        };
  } catch (error) {
    return {
      status: "failed",
      reason: `解析 MinIO Tenant status 失败：${errorReason(error)}`,
      captures: [service, tenant],
    };
  }
}
