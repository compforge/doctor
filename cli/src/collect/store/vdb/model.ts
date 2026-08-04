import type { Diagnosis, Evidence, FindingMeta } from "../../protocol";
import type { VdbInspectionFacts } from "./fact/model";

export interface OpenSearchHealthObservation {
  id: "vdb-health";
  kind: "opensearch-health";
  status: string;
  clusterName?: string;
  nodes: number;
  dataNodes: number;
  activePrimaryShards: number;
  activeShards: number;
  unassignedShards: number;
  initializingShards: number;
  relocatingShards: number;
  pendingTasks: number;
}

export interface OpenSearchAllocationNode {
  node: string;
  shards: number;
  diskUsedBytes?: number;
  diskAvailableBytes?: number;
  diskTotalBytes?: number;
  diskPercent?: number;
}

export interface OpenSearchAllocationObservation {
  id: "vdb-allocation";
  kind: "opensearch-allocation";
  nodes: OpenSearchAllocationNode[];
}

export interface OpenSearchStatsObservation {
  id: "vdb-stats";
  kind: "opensearch-stats";
  indices: number;
  documents: number;
  deletedDocuments: number;
  storeBytes: number;
  shards: number;
  primaryShards: number;
}

export interface OpenSearchShardObservation {
  id: "vdb-shards";
  kind: "opensearch-shards";
  total: number;
  unassigned: number;
  unassignedPrimary: number;
  unassignedReplica: number;
}

export type OpenSearchDiskWatermark =
  | { raw: string; kind: "used-ratio"; usedRatio: number; maxHeadroomBytes?: number }
  | { raw: string; kind: "free-bytes"; freeBytes: number }
  | { raw: string; kind: "unknown" };

export interface OpenSearchDiskSettingsObservation {
  id: "vdb-disk-settings";
  kind: "opensearch-disk-settings";
  low: OpenSearchDiskWatermark;
  high: OpenSearchDiskWatermark;
  floodStage: OpenSearchDiskWatermark;
  source: "cluster-settings" | "fallback-defaults";
}

export interface OpenSearchIndexBlocksObservation {
  id: "vdb-index-blocks";
  kind: "opensearch-index-blocks";
  readOnlyAllowDelete: string[];
}

export interface VdbObservations {
  health?: OpenSearchHealthObservation;
  allocation?: OpenSearchAllocationObservation;
  stats?: OpenSearchStatsObservation;
  shards?: OpenSearchShardObservation;
  diskSettings?: OpenSearchDiskSettingsObservation;
  indexBlocks?: OpenSearchIndexBlocksObservation;
  missing: string[];
}

export type VdbObservation =
  | OpenSearchHealthObservation
  | OpenSearchAllocationObservation
  | OpenSearchStatsObservation
  | OpenSearchShardObservation
  | OpenSearchDiskSettingsObservation
  | OpenSearchIndexBlocksObservation;

export type VdbFindingKind =
  | "vdb.cluster-red"
  | "vdb.cluster-yellow"
  | "vdb.disk-capacity-high"
  | "vdb.disk-capacity-exhausted"
  | "vdb.index-write-blocked"
  | "vdb.unassigned-primary-shards"
  | "vdb.unassigned-replica-shards";

export interface VdbFinding extends FindingMeta<VdbFindingKind> {
  summary: string;
}

export type VdbDiagnosisGoal = "cluster-health" | "capacity" | "shard-state";
export type VdbEvidence = Evidence<VdbObservation, VdbInspectionFacts>;
export type VdbDiagnosis = Diagnosis<VdbEvidence, VdbFinding, VdbDiagnosisGoal>;

export function groupVdbObservations(
  observations: readonly VdbObservation[],
): VdbObservations {
  const find = <Kind extends VdbObservation["kind"]>(kind: Kind) =>
    observations.find((item) => item.kind === kind) as Extract<VdbObservation, { kind: Kind }> | undefined;
  const health = find("opensearch-health");
  const allocation = find("opensearch-allocation");
  const stats = find("opensearch-stats");
  const shards = find("opensearch-shards");
  const diskSettings = find("opensearch-disk-settings");
  const indexBlocks = find("opensearch-index-blocks");
  return {
    health,
    allocation,
    stats,
    shards,
    diskSettings,
    indexBlocks,
    missing: [
      ...(!health ? ["cluster health"] : []),
      ...(!allocation ? ["node allocation"] : []),
      ...(!stats ? ["cluster stats"] : []),
      ...(!shards ? ["shard state"] : []),
      ...(!diskSettings ? ["cluster disk watermarks（容量判读回退常见默认值）"] : []),
      ...(!indexBlocks ? ["index read_only_allow_delete blocks"] : []),
    ],
  };
}
