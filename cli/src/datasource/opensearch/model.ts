import type * as health from "@compforge/harness-toolbox/opensearch/health";
import type { FindingMeta, ObservationMeta } from "../../collect/protocol";

// Harness owns protocol identity and analysis; Doctor adds evidence provenance.
export type OpenSearchHealthObservation = health.OpenSearchHealthObservation & ObservationMeta;
export type OpenSearchAllocationObservation = health.OpenSearchAllocationObservation & ObservationMeta;
export type OpenSearchStatsObservation = health.OpenSearchStatsObservation & ObservationMeta;
export type OpenSearchShardObservation = health.OpenSearchShardObservation & ObservationMeta;
export type OpenSearchDiskSettingsObservation = health.OpenSearchDiskSettingsObservation & ObservationMeta;
export type OpenSearchIndexBlocksObservation = health.OpenSearchIndexBlocksObservation & ObservationMeta;
export type { OpenSearchAllocationNode, OpenSearchDiskWatermark } from "@compforge/harness-toolbox/opensearch/health";
export type VdbObservation = health.OpenSearchObservation & ObservationMeta;
export type VdbFindingKind = health.OpenSearchFindingKind;
export type VdbFinding = health.OpenSearchFinding & FindingMeta<VdbFindingKind>;

export interface VdbObservations {
  health?: OpenSearchHealthObservation;
  allocation?: OpenSearchAllocationObservation;
  stats?: OpenSearchStatsObservation;
  shards?: OpenSearchShardObservation;
  diskSettings?: OpenSearchDiskSettingsObservation;
  indexBlocks?: OpenSearchIndexBlocksObservation;
  missing: string[];
}

export type VdbDiagnosisGoal = "cluster-health" | "capacity" | "shard-state";

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
