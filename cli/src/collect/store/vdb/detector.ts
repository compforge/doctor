import { evidenceGaps, type EvidenceGapFinding } from "../../evidence-gaps";
import type { Detector, } from "../../protocol";
import type { VdbEvidence, VdbFinding } from "./model";
import { groupVdbObservations } from "./model";
import { detectVdbFindings, effectiveDiskSettings } from "../../../datasource/opensearch/detector";
export * from "../../../datasource/opensearch/detector";

export const vdbDetectors: readonly Detector<VdbEvidence, VdbFinding>[] = [
  (evidence) => detectVdbFindings(groupVdbObservations(evidence.observations)),
];

export function detectVdbEvidenceGaps(
  evidence: VdbEvidence,
): EvidenceGapFinding[] {
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
    ...evidenceGaps("cluster-health", healthMissing, evidence),
    ...evidenceGaps("capacity", capacityMissing, evidence),
    ...evidenceGaps("shard-state", shardMissing, evidence),
  ];
}
