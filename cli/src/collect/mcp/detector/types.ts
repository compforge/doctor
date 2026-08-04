import type { Detector, FindingMeta } from "../../protocol";
import type { McpEvidence } from "../model";

export type McpFindingKind =
  | "mcp.protocol-path-failure"
  | "mcp.common-downstream-failure"
  | "mcp.http-replay-divergence";

export interface McpFinding extends FindingMeta<McpFindingKind> {
  summary: string;
}

export type McpDetector = Detector<McpEvidence, McpFinding>;
