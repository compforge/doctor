import { evidenceGaps, type EvidenceGapFinding } from "../../evidence-gaps";
import type { } from "../../protocol";
import {
  gatewayLogsObservation,
  httpCallObservation,
  mcpCallObservation,
  type McpEvidence,
} from "../model";

export function detectMcpEvidenceGaps(
  evidence: McpEvidence,
): EvidenceGapFinding[] {
  const mcp = mcpCallObservation(evidence);
  const http = httpCallObservation(evidence);
  const logs = gatewayLogsObservation(evidence);
  return [
    ...evidenceGaps("mcp-call", mcp ? [] : ["MCP tools/call 真实响应"], evidence),
    ...evidenceGaps("http-comparison", [
        ...(mcp ? [] : ["MCP tools/call 真实响应"]),
        ...(http ? [] : ["映射后直接 HTTP 响应"]),
      ], evidence),
    ...evidenceGaps("gateway-logs", logs?.ok
        ? []
        : [logs?.reason ?? "本次调用窗口的 MCP Service 日志"], evidence),
  ];
}
