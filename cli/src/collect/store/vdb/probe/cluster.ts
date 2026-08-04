import type {
  OpenSearchHealthObservation,
  OpenSearchShardObservation,
  OpenSearchStatsObservation,
} from "../model";
import type { VdbOpenSearchProbeSpec } from "./opensearch";
import { numberValue, record, stringValue } from "./value";

export function parseHealth(raw: unknown): OpenSearchHealthObservation {
  const value = record(raw);
  return {
    id: "vdb-health",
    kind: "opensearch-health",
    status: stringValue(value.status).toLowerCase(),
    clusterName: stringValue(value.cluster_name) || undefined,
    nodes: numberValue(value.number_of_nodes),
    dataNodes: numberValue(value.number_of_data_nodes),
    activePrimaryShards: numberValue(value.active_primary_shards),
    activeShards: numberValue(value.active_shards),
    unassignedShards: numberValue(value.unassigned_shards),
    initializingShards: numberValue(value.initializing_shards),
    relocatingShards: numberValue(value.relocating_shards),
    pendingTasks: numberValue(value.number_of_pending_tasks),
  };
}

export function parseStats(raw: unknown): OpenSearchStatsObservation {
  const indices = record(record(raw).indices);
  const docs = record(indices.docs);
  const store = record(indices.store);
  const shards = record(indices.shards);
  return {
    id: "vdb-stats",
    kind: "opensearch-stats",
    indices: numberValue(indices.count),
    documents: numberValue(docs.count),
    deletedDocuments: numberValue(docs.deleted),
    storeBytes: numberValue(store.size_in_bytes),
    shards: numberValue(shards.total),
    primaryShards: numberValue(shards.primaries),
  };
}

export function parseShards(raw: unknown): OpenSearchShardObservation {
  const rows = Array.isArray(raw) ? raw.map(record) : [];
  const unassigned = rows.filter((row) => stringValue(row.state).toUpperCase() === "UNASSIGNED");
  const primary = unassigned.filter((row) => stringValue(row.prirep).toLowerCase() === "p").length;
  return {
    id: "vdb-shards",
    kind: "opensearch-shards",
    total: rows.length,
    unassigned: unassigned.length,
    unassignedPrimary: primary,
    unassignedReplica: unassigned.length - primary,
  };
}

export const CLUSTER_HEALTH_PROBE: VdbOpenSearchProbeSpec = {
  id: "cluster-health",
  outcome: "cluster-health",
  path: "/_cluster/health",
  parse: parseHealth,
};

export const CLUSTER_STATS_PROBE: VdbOpenSearchProbeSpec = {
  id: "cluster-stats",
  outcome: "cluster-stats",
  path: "/_cluster/stats",
  parse: parseStats,
};

export const SHARD_STATE_PROBE: VdbOpenSearchProbeSpec = {
  id: "shard-state",
  outcome: "shard-state",
  path: "/_cat/shards",
  query: { format: "json", bytes: "b" },
  parse: parseShards,
};
