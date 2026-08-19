import type { Probe } from "../../../protocol";
import type { VdbConfig } from "../config";
import type { VdbCommandContext } from "../context";
import type { VdbInspectionFacts } from "../fact/model";
import type { VdbObservation } from "../model";
import {
  CLUSTER_SETTINGS_PROBE,
  INDEX_WRITE_BLOCKS_PROBE,
  NODE_ALLOCATION_PROBE,
} from "./capacity";
import {
  CLUSTER_HEALTH_PROBE,
  CLUSTER_STATS_PROBE,
  SHARD_STATE_PROBE,
} from "./cluster";
import { makeOpenSearchProbe } from "./opensearch";

export function makeVdbProbes(): Array<
  Probe<VdbObservation, VdbInspectionFacts, VdbConfig, VdbCommandContext>
> {
  return [
    CLUSTER_HEALTH_PROBE,
    NODE_ALLOCATION_PROBE,
    CLUSTER_STATS_PROBE,
    SHARD_STATE_PROBE,
    CLUSTER_SETTINGS_PROBE,
    INDEX_WRITE_BLOCKS_PROBE,
  ].map(makeOpenSearchProbe);
}

export * from "./capacity";
export * from "./cluster";
