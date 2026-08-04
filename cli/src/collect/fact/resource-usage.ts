import type { ContainerInfo } from "../../infra/k8s/target";

export const HIGH_RESOURCE_USAGE_RATIO = 0.8;

export interface ResourceUsageValue {
  current: string;
  limit?: string;
  ratio?: number;
}

export interface ContainerResourceUsage {
  cpu: ResourceUsageValue;
  memory: ResourceUsageValue;
}

export function parseKubernetesBytes(quantity: string | undefined): number | undefined {
  const match = quantity?.trim().match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) return undefined;
  const units: Record<string, number> = {
    "": 1,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  return Number(match[1]) * units[match[2] ?? ""]!;
}

function parseCpuCores(quantity: string | undefined): number | undefined {
  const match = quantity?.trim().match(/^([0-9]+(?:\.[0-9]+)?)(n|u|m)?$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  switch (match[2]) {
    case "n":
      return value / 1_000_000_000;
    case "u":
      return value / 1_000_000;
    case "m":
      return value / 1_000;
    default:
      return value;
  }
}

export function parseContainerResourceUsage(
  raw: string,
  podName: string,
  container: ContainerInfo,
): ContainerResourceUsage | undefined {
  const row = raw.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns[0] === podName && columns[1] === container.name);
  if (!row || row.length < 4) return undefined;

  const cpuCurrent = row[2]!;
  const memoryCurrent = row[3]!;
  const cpuLimit = container.limits?.cpu;
  const memoryLimit = container.limits?.memory;
  const currentCpuCores = parseCpuCores(cpuCurrent);
  const limitCpuCores = parseCpuCores(cpuLimit);
  const currentMemoryBytes = parseKubernetesBytes(memoryCurrent);
  const limitMemoryBytes = parseKubernetesBytes(memoryLimit);
  return {
    cpu: {
      current: cpuCurrent,
      limit: cpuLimit,
      ratio: currentCpuCores !== undefined && limitCpuCores
        ? currentCpuCores / limitCpuCores
        : undefined,
    },
    memory: {
      current: memoryCurrent,
      limit: memoryLimit,
      ratio: currentMemoryBytes !== undefined && limitMemoryBytes
        ? currentMemoryBytes / limitMemoryBytes
        : undefined,
    },
  };
}

function formatValue(name: string, value: ResourceUsageValue): string {
  const ratio = value.ratio === undefined ? "占用率未知" : `${(value.ratio * 100).toFixed(1)}%`;
  return `${name} ${ratio}（${value.current} / limit ${value.limit ?? "未配置"}）`;
}

export function formatContainerResourceUsage(usage: ContainerResourceUsage): string {
  return `${formatValue("CPU", usage.cpu)}，${formatValue("内存", usage.memory)}`;
}

export function isHighContainerResourceUsage(usage: ContainerResourceUsage): boolean {
  return [usage.cpu.ratio, usage.memory.ratio]
    .some((ratio) => ratio !== undefined && ratio >= HIGH_RESOURCE_USAGE_RATIO);
}
