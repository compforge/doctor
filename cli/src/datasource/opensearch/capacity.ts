import * as health from "@compforge/harness-toolbox/opensearch/health";
import { observation } from "./metadata";
export const parseAllocation = (...args: Parameters<typeof health.parseAllocation>) => observation(health.parseAllocation(...args));
export const parseDiskSettings = (...args: Parameters<typeof health.parseDiskSettings>) => observation(health.parseDiskSettings(...args));
export const parseIndexBlocks = (...args: Parameters<typeof health.parseIndexBlocks>) => observation(health.parseIndexBlocks(...args));
export const NODE_ALLOCATION_PROBE = { ...health.NODE_ALLOCATION_PROBE, parse: (raw: unknown) => observation(health.NODE_ALLOCATION_PROBE.parse(raw)) };
export const CLUSTER_SETTINGS_PROBE = { ...health.CLUSTER_SETTINGS_PROBE, parse: (raw: unknown) => observation(health.CLUSTER_SETTINGS_PROBE.parse(raw)) };
export const INDEX_WRITE_BLOCKS_PROBE = { ...health.INDEX_WRITE_BLOCKS_PROBE, parse: (raw: unknown) => observation(health.INDEX_WRITE_BLOCKS_PROBE.parse(raw)) };
