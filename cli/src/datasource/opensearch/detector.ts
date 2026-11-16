import * as health from "@compforge/harness-toolbox/opensearch/health";
import type { VdbObservations, VdbFinding } from "./model";
import { observation } from "./metadata";
export const vdbCapacityConclusion = health.vdbCapacityConclusion;
export const effectiveDiskSettings = (value: VdbObservations) => observation(health.effectiveDiskSettings(value));
export const detectVdbFindings = (value: VdbObservations): VdbFinding[] => health.detectVdbFindings(value).map(item => ({ ...item,
  schemaVersion: 1, producer: { origin: "core", id: "vdb-health" } }));
