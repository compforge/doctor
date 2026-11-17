import * as health from "@compforge/harness-toolbox/vectordb/opensearch/health";
import type { VdbObservations, VdbFinding } from "./model";
export const vdbCapacityConclusion = health.openSearchCapacityConclusion;
export const detectVdbFindings = (value: VdbObservations): VdbFinding[] => health.analyzeOpenSearch(value).map(item => ({ ...item,
  schemaVersion: 1, producer: { origin: "core", id: "vdb-health" } }));
