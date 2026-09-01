import type { Detector, DiagnosisCoverage } from "../../protocol";
import type {
  OpenSearchAllocationNode,
  OpenSearchDiskSettingsObservation,
  OpenSearchDiskWatermark,
  VdbDiagnosisGoal,
  VdbEvidence,
  VdbFinding,
  VdbObservations,
} from "./model";
import { groupVdbObservations } from "./model";

const FALLBACK_DISK_SETTINGS: OpenSearchDiskSettingsObservation = {
  id: "vdb-disk-settings",
  kind: "opensearch-disk-settings",
  schemaVersion: 1,
  producer: { origin: "core", id: "vdb-detector-defaults" },
  low: { raw: "85%", kind: "used-ratio", usedRatio: 0.85 },
  high: { raw: "90%", kind: "used-ratio", usedRatio: 0.9 },
  floodStage: { raw: "95%", kind: "used-ratio", usedRatio: 0.95 },
  source: "fallback-defaults",
};

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "vdb-health" },
};

export function effectiveDiskSettings(observations: VdbObservations): OpenSearchDiskSettingsObservation {
  const collected = observations.diskSettings;
  if (!collected) return FALLBACK_DISK_SETTINGS;
  const usedFallback = [collected.low, collected.high, collected.floodStage]
    .some((watermark) => watermark.kind === "unknown");
  return {
    ...collected,
    low: collected.low.kind === "unknown" ? FALLBACK_DISK_SETTINGS.low : collected.low,
    high: collected.high.kind === "unknown" ? FALLBACK_DISK_SETTINGS.high : collected.high,
    floodStage: collected.floodStage.kind === "unknown"
      ? FALLBACK_DISK_SETTINGS.floodStage
      : collected.floodStage,
    source: usedFallback ? "fallback-defaults" : "cluster-settings",
  };
}

function watermarkCrossed(node: OpenSearchAllocationNode, watermark: OpenSearchDiskWatermark): boolean {
  if (watermark.kind === "free-bytes") {
    return node.diskAvailableBytes !== undefined && node.diskAvailableBytes < watermark.freeBytes;
  }
  if (watermark.kind !== "used-ratio") return false;
  if (node.diskAvailableBytes !== undefined && node.diskTotalBytes !== undefined) {
    const ratioFree = node.diskTotalBytes * (1 - watermark.usedRatio);
    const requiredFree = watermark.maxHeadroomBytes === undefined
      ? ratioFree
      : Math.min(ratioFree, watermark.maxHeadroomBytes);
    return node.diskAvailableBytes < requiredFree;
  }
  return node.diskPercent !== undefined && node.diskPercent >= watermark.usedRatio * 100;
}

function firstCrossed(
  nodes: readonly OpenSearchAllocationNode[],
  watermark: OpenSearchDiskWatermark,
): OpenSearchAllocationNode | undefined {
  return nodes.find((node) => watermarkCrossed(node, watermark));
}

export function detectVdbFindings(observations: VdbObservations): VdbFinding[] {
  const findings: VdbFinding[] = [];
  const health = observations.health;
  if (health?.status === "red") {
    findings.push({
      ...FINDING_META,
      id: "cluster-red",
      kind: "vdb.cluster-red",
      severity: "critical",
      confidence: "high",
      evidence: [{ observationId: health.id, role: "supporting" }],
      summary: "OpenSearch cluster health 为 red，存在 primary shard 不可用。",
    });
  } else if (health?.status === "yellow") {
    findings.push({
      ...FINDING_META,
      id: "cluster-yellow",
      kind: "vdb.cluster-yellow",
      severity: "warning",
      confidence: "high",
      evidence: [{ observationId: health.id, role: "supporting" }],
      summary: "OpenSearch cluster health 为 yellow，部分 replica shard 未正常分配。",
    });
  }

  const blocked = observations.indexBlocks?.readOnlyAllowDelete ?? [];
  if (blocked.length) {
    findings.push({
      ...FINDING_META,
      id: "index-write-blocked",
      kind: "vdb.index-write-blocked",
      severity: "critical",
      confidence: "high",
      evidence: [{ observationId: "vdb-index-blocks", role: "supporting" }],
      summary: `${blocked.length} 个 index 已设置 read_only_allow_delete，写入当前受限。`,
    });
  }

  const nodes = observations.allocation?.nodes ?? [];
  const settings = effectiveDiskSettings(observations);
  const confidence = settings.source === "cluster-settings" ? "high" : "medium";
  const floodNode = firstCrossed(nodes, settings.floodStage);
  const highNode = firstCrossed(nodes, settings.high);
  if (floodNode) {
    findings.push({
      ...FINDING_META,
      id: "disk-capacity-exhausted",
      kind: "vdb.disk-capacity-exhausted",
      severity: "critical",
      confidence,
      evidence: [{ observationId: "vdb-allocation", role: "supporting" }],
      summary: `${floodNode.node} 已越过 flood-stage 水位 ${settings.floodStage.raw}`
        + `${floodNode.diskPercent === undefined ? "" : `（使用率 ${floodNode.diskPercent}%）`}。`,
    });
  } else if (highNode) {
    findings.push({
      ...FINDING_META,
      id: "disk-capacity-high",
      kind: "vdb.disk-capacity-high",
      severity: "warning",
      confidence,
      evidence: [{ observationId: "vdb-allocation", role: "supporting" }],
      summary: `${highNode.node} 已越过 high 水位 ${settings.high.raw}`
        + `${highNode.diskPercent === undefined ? "" : `（使用率 ${highNode.diskPercent}%）`}。`,
    });
  }

  const shards = observations.shards;
  if ((shards?.unassignedPrimary ?? 0) > 0) {
    findings.push({
      ...FINDING_META,
      id: "unassigned-primary-shards",
      kind: "vdb.unassigned-primary-shards",
      severity: "critical",
      confidence: "high",
      evidence: [{ observationId: shards!.id, role: "supporting" }],
      summary: `存在 ${shards!.unassignedPrimary} 个 UNASSIGNED primary shard。`,
    });
  }
  if ((shards?.unassignedReplica ?? 0) > 0) {
    findings.push({
      ...FINDING_META,
      id: "unassigned-replica-shards",
      kind: "vdb.unassigned-replica-shards",
      severity: "warning",
      confidence: "high",
      evidence: [{ observationId: shards!.id, role: "supporting" }],
      summary: `存在 ${shards!.unassignedReplica} 个 UNASSIGNED replica shard。`,
    });
  }
  return findings;
}

export function vdbCapacityConclusion(observations: VdbObservations): string {
  const blocked = observations.indexBlocks?.readOnlyAllowDelete ?? [];
  if (blocked.length) return `写入已受限（${blocked.length} 个 index 为 read_only_allow_delete）`;
  const nodes = observations.allocation?.nodes ?? [];
  const maxPercent = Math.max(
    ...(nodes
      .map((node) => node.diskPercent)
      .filter((value): value is number => value !== undefined)),
    -1,
  );
  if (!nodes.length) return "无法判断：未取得 data node 磁盘利用率";
  const settings = effectiveDiskSettings(observations);
  const suffix = settings.source === "cluster-settings" ? "" : "；未取得实时水位，按常见默认值判断";
  if (firstCrossed(nodes, settings.floodStage)) {
    return `容量已越过 flood-stage ${settings.floodStage.raw}${maxPercent < 0 ? "" : `（最高 ${maxPercent}%）`}${suffix}`;
  }
  if (firstCrossed(nodes, settings.high)) {
    return `容量已越过 high 水位 ${settings.high.raw}${maxPercent < 0 ? "" : `（最高 ${maxPercent}%）`}${suffix}`;
  }
  return `容量未越过 high 水位 ${settings.high.raw}${maxPercent < 0 ? "" : `（最高 ${maxPercent}%）`}${suffix}`;
}

export const vdbDetectors: readonly Detector<VdbEvidence, VdbFinding>[] = [
  (evidence) => detectVdbFindings(groupVdbObservations(evidence.observations)),
];

export function buildVdbCoverage(
  evidence: VdbEvidence,
): DiagnosisCoverage<VdbDiagnosisGoal>[] {
  const observations = groupVdbObservations(evidence.observations);
  const accessReason = evidence.facts.access.status === "collected"
    ? undefined
    : evidence.facts.access.reason;
  const diskSettings = effectiveDiskSettings(observations);
  const healthMissing = observations.health ? [] : [accessReason ?? "cluster health 未取得"];
  const capacityMissing = [
    ...(!observations.allocation ? [accessReason ?? "node allocation 未取得"] : []),
    ...(diskSettings.source === "fallback-defaults"
      ? ["cluster disk watermarks 未完整取得，缺失项按常见默认值判断"]
      : []),
    ...(!observations.indexBlocks ? ["index read_only_allow_delete 状态未取得"] : []),
  ];
  const shardMissing = observations.shards ? [] : [accessReason ?? "shard state 未取得"];
  return [
    {
      goal: "cluster-health",
      status: healthMissing.length ? "insufficient" : "sufficient",
      missingEvidence: healthMissing,
    },
    {
      goal: "capacity",
      status: !observations.allocation
        ? "insufficient"
        : capacityMissing.length ? "partial" : "sufficient",
      missingEvidence: capacityMissing,
    },
    {
      goal: "shard-state",
      status: shardMissing.length ? "insufficient" : "sufficient",
      missingEvidence: shardMissing,
    },
  ];
}
