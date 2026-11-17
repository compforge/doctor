import type { OpenSearchObservation } from "@compforge/harness-toolbox/opensearch/health";
const producers = { "opensearch-health": "cluster-health", "opensearch-allocation": "node-allocation", "opensearch-stats": "cluster-stats", "opensearch-shards": "shard-state", "opensearch-disk-settings": "cluster-settings", "opensearch-index-blocks": "index-write-blocks" } as const;
/** Attach Doctor evidence provenance only at the Collect boundary. */
export function observation<T extends OpenSearchObservation>(value: T) {
  return { ...value, schemaVersion: 1, producer: { origin: "core" as const, id: producers[value.kind] } };
}
