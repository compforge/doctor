import * as health from "@compforge/harness-toolbox/opensearch/health";
import { observation } from "./metadata";
export const parseHealth = (...args: Parameters<typeof health.parseHealth>) => observation(health.parseHealth(...args));
export const parseStats = (...args: Parameters<typeof health.parseStats>) => observation(health.parseStats(...args));
export const parseShards = (...args: Parameters<typeof health.parseShards>) => observation(health.parseShards(...args));
export const CLUSTER_HEALTH_PROBE = { ...health.CLUSTER_HEALTH_PROBE, parse: (raw: unknown) => observation(health.CLUSTER_HEALTH_PROBE.parse(raw)) };
export const CLUSTER_STATS_PROBE = { ...health.CLUSTER_STATS_PROBE, parse: (raw: unknown) => observation(health.CLUSTER_STATS_PROBE.parse(raw)) };
export const SHARD_STATE_PROBE = { ...health.SHARD_STATE_PROBE, parse: (raw: unknown) => observation(health.SHARD_STATE_PROBE.parse(raw)) };
