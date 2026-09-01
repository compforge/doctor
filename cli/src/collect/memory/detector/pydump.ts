import type { DiagnosisCoverage, FindingMeta } from "../../protocol";
import type { PydumpAnalysis, PydumpRetainedObject, PydumpTypeSummary } from "../pydump-analysis";

export type PydumpDiagnosisGoal = "heap-composition" | "retained-ownership" | "leak-confirmation";

export type PydumpFinding =
  | (FindingMeta<"memory.pydump-type-concentration"> & {
      dominantTypes: Array<PydumpTypeSummary & { heap_share: number }>;
      combinedHeapShare: number;
    })
  | (FindingMeta<"memory.pydump-retained-owners"> & {
      owners: Array<PydumpRetainedObject & { heap_share: number }>;
    })
  | (FindingMeta<"memory.pydump-retained-distributed"> & {
      largestOwner: PydumpRetainedObject & { heap_share: number };
    })
  | (FindingMeta<"memory.pydump-known-runtime-owner"> & {
      runtimeOwner: "sys.path_importer_cache";
      owner: PydumpRetainedObject;
    });

export interface PydumpDiagnosis {
  findings: PydumpFinding[];
  coverage: DiagnosisCoverage<PydumpDiagnosisGoal>[];
}

const CONCENTRATED_TYPE_SHARE = 0.1;
const RETAINED_OWNER_SHARE = 0.05;

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "pydump-analysis" },
};

function typeCount(owner: PydumpRetainedObject, side: "key_types" | "value_types", typeName: string): number {
  return owner.container_profile?.[side]?.find((item) => item.type_name === typeName)?.object_count ?? 0;
}

function looksLikePathImporterCache(owner: PydumpRetainedObject): boolean {
  const itemCount = owner.container_profile?.item_count ?? 0;
  const fileFinders = typeCount(owner, "value_types", "FileFinder");
  const isModuleOwned = owner.inbound_reference_paths?.some(
    (path) => path.at(-1)?.type_name === "module" && path.some((node) => node.type_name === "dict"),
  ) ?? false;
  return owner.type_name === "dict"
    && itemCount > 0
    && typeCount(owner, "key_types", "str") === itemCount
    && fileFinders / itemCount >= 0.8
    && isModuleOwned;
}

export function diagnosePydumpAnalysis(analysis: PydumpAnalysis): PydumpDiagnosis {
  const total = analysis.heap.shallow_size_bytes;
  const dominantTypes = analysis.types
    .map((type) => ({ ...type, heap_share: total > 0 ? type.shallow_size_bytes / total : 0 }))
    .filter((type) => type.heap_share >= CONCENTRATED_TYPE_SHARE)
    .slice(0, 5);
  const findings: PydumpFinding[] = [];
  if (dominantTypes.length > 0) {
    findings.push({
      ...FINDING_META,
      id: "memory.pydump-type-concentration",
      kind: "memory.pydump-type-concentration",
      severity: "info",
      confidence: "high",
      evidence: [{ observationId: "pydump-analysis", role: "supporting" }],
      dominantTypes,
      combinedHeapShare: dominantTypes.reduce((sum, type) => sum + type.heap_share, 0),
    });
  }

  const pathImporterCache = analysis.retained_heap.top_objects.find(looksLikePathImporterCache);
  if (pathImporterCache) {
    findings.push({
      ...FINDING_META,
      id: "memory.pydump-known-runtime-owner",
      kind: "memory.pydump-known-runtime-owner",
      severity: "info",
      confidence: "medium",
      evidence: [{ observationId: "pydump-analysis", role: "supporting" }],
      runtimeOwner: "sys.path_importer_cache",
      owner: pathImporterCache,
    });
  }

  if (analysis.retained_heap.status === "complete") {
    const owners = analysis.retained_heap.top_objects
      .map((owner) => ({ ...owner, heap_share: total > 0 ? owner.retained_size_bytes / total : 0 }))
      .filter((owner) => owner.heap_share >= RETAINED_OWNER_SHARE)
      .slice(0, 10);
    if (owners.length > 0) {
      findings.push({
        ...FINDING_META,
        id: "memory.pydump-retained-owners",
        kind: "memory.pydump-retained-owners",
        severity: "warning",
        confidence: "high",
        evidence: [{ observationId: "pydump-analysis", role: "supporting" }],
        owners,
      });
    } else if (analysis.retained_heap.top_objects[0]) {
      const largest = analysis.retained_heap.top_objects[0];
      findings.push({
        ...FINDING_META,
        id: "memory.pydump-retained-distributed",
        kind: "memory.pydump-retained-distributed",
        severity: "info",
        confidence: "high",
        evidence: [{ observationId: "pydump-analysis", role: "supporting" }],
        largestOwner: {
          ...largest,
          heap_share: total > 0 ? largest.retained_size_bytes / total : 0,
        },
      });
    }
  }

  return {
    findings,
    coverage: [
      { goal: "heap-composition", status: "sufficient", missingEvidence: [] },
      analysis.retained_heap.status === "complete"
        ? { goal: "retained-ownership", status: "sufficient", missingEvidence: [] }
        : {
          goal: "retained-ownership",
          status: "insufficient",
          missingEvidence: ["analyzer retained-heap 计算结果"],
        },
      {
        goal: "leak-confirmation",
        status: "insufficient",
        missingEvidence: ["同一进程生命周期的多次 heap dump 趋势，或 allocation history"],
      },
    ],
  };
}
