import { DATASOURCE_HEALTH_KIND, type DataSourceHealthExtension } from "../datasource/health/extension";

/** @spec Builtin discovery is offline; backend implementation and I/O are loaded only during invocation. */
export const OPENSEARCH_HEALTH_EXTENSION: DataSourceHealthExtension = {
  id: "opensearch-health", kind: DATASOURCE_HEALTH_KIND, backend: "opensearch",
  description: "OpenSearch 集群、磁盘水位、分片与写入限制的只读健康探测",
  run: async input => (await import("../datasource/opensearch/health")).probeOpenSearchHealth(input),
};
export const BUILTIN_EXTENSIONS = [OPENSEARCH_HEALTH_EXTENSION] as const;
