import type {
  OpenSearchAllocationNode,
  OpenSearchAllocationObservation,
  OpenSearchDiskSettingsObservation,
  OpenSearchDiskWatermark,
  OpenSearchIndexBlocksObservation,
} from "../model";
import type { VdbOpenSearchProbeSpec } from "./opensearch";
import { numberValue, record, stringValue } from "./value";

export function parseAllocation(raw: unknown): OpenSearchAllocationObservation {
  const rows = Array.isArray(raw) ? raw : [];
  const nodes = rows.map((rawRow): OpenSearchAllocationNode => {
    const row = record(rawRow);
    const optionalNumber = (value: unknown) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    return {
      node: stringValue(row.node) || stringValue(row.ip) || "unknown",
      shards: numberValue(row.shards),
      diskUsedBytes: optionalNumber(row["disk.used"]),
      diskAvailableBytes: optionalNumber(row["disk.avail"]),
      diskTotalBytes: optionalNumber(row["disk.total"]),
      diskPercent: optionalNumber(row["disk.percent"]),
    };
  });
  return { id: "vdb-allocation", kind: "opensearch-allocation", nodes };
}

function parseBytes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const matched = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)$/);
  if (!matched) return undefined;
  const unit = ["b", "kb", "mb", "gb", "tb", "pb"].indexOf(matched[2]!);
  return Number(matched[1]) * 1024 ** unit;
}

function parseWatermark(rawValue: unknown, maxHeadroom: unknown): OpenSearchDiskWatermark {
  const raw = stringValue(rawValue).trim();
  const headroom = parseBytes(stringValue(maxHeadroom).trim());
  if (raw.endsWith("%")) {
    const ratio = Number(raw.slice(0, -1)) / 100;
    if (Number.isFinite(ratio)) return { raw, kind: "used-ratio", usedRatio: ratio, maxHeadroomBytes: headroom };
  }
  const ratio = Number(raw);
  if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
    return { raw, kind: "used-ratio", usedRatio: ratio, maxHeadroomBytes: headroom };
  }
  const freeBytes = parseBytes(raw);
  if (freeBytes !== undefined) return { raw, kind: "free-bytes", freeBytes };
  return { raw, kind: "unknown" };
}

function setting(raw: Record<string, unknown>, name: string): unknown {
  for (const scope of ["transient", "persistent", "defaults"]) {
    const value = record(raw[scope])[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parseDiskSettings(rawValue: unknown): OpenSearchDiskSettingsObservation {
  const raw = record(rawValue);
  const prefix = "cluster.routing.allocation.disk.watermark.";
  return {
    id: "vdb-disk-settings",
    kind: "opensearch-disk-settings",
    low: parseWatermark(setting(raw, `${prefix}low`), setting(raw, `${prefix}low.max_headroom`)),
    high: parseWatermark(setting(raw, `${prefix}high`), setting(raw, `${prefix}high.max_headroom`)),
    floodStage: parseWatermark(
      setting(raw, `${prefix}flood_stage`),
      setting(raw, `${prefix}flood_stage.max_headroom`),
    ),
    source: "cluster-settings",
  };
}

export function parseIndexBlocks(rawValue: unknown): OpenSearchIndexBlocksObservation {
  const indices = record(rawValue);
  const readOnlyAllowDelete = Object.entries(indices).flatMap(([name, rawIndex]) => {
    const settings = record(record(rawIndex).settings);
    const blocks = record(record(settings.index).blocks);
    const value = settings["index.blocks.read_only_allow_delete"]
      ?? blocks.read_only_allow_delete;
    return value === true || value === "true" ? [name] : [];
  });
  return {
    id: "vdb-index-blocks",
    kind: "opensearch-index-blocks",
    readOnlyAllowDelete,
  };
}

export const NODE_ALLOCATION_PROBE: VdbOpenSearchProbeSpec = {
  id: "node-allocation",
  outcome: "node-allocation",
  path: "/_cat/allocation",
  query: { format: "json", bytes: "b" },
  parse: parseAllocation,
};

export const CLUSTER_SETTINGS_PROBE: VdbOpenSearchProbeSpec = {
  id: "cluster-settings",
  outcome: "cluster-settings",
  path: "/_cluster/settings",
  query: { include_defaults: true, flat_settings: true },
  parse: parseDiskSettings,
};

export const INDEX_WRITE_BLOCKS_PROBE: VdbOpenSearchProbeSpec = {
  id: "index-write-blocks",
  outcome: "index-write-blocks",
  path: "/_all/_settings",
  query: {
    flat_settings: true,
    filter_path: "*.settings.index.blocks.read_only_allow_delete",
  },
  parse: parseIndexBlocks,
};
