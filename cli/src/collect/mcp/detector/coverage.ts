import type { DiagnosisCoverage } from "../../protocol";
import {
  gatewayLogsObservation,
  httpCallObservation,
  mcpCallObservation,
  type McpDiagnosisGoal,
  type McpEvidence,
} from "../model";

export function buildMcpCoverage(
  evidence: McpEvidence,
): DiagnosisCoverage<McpDiagnosisGoal>[] {
  const mcp = mcpCallObservation(evidence);
  const http = httpCallObservation(evidence);
  const logs = gatewayLogsObservation(evidence);
  return [
    {
      goal: "mcp-call",
      status: mcp ? "sufficient" : "insufficient",
      missingEvidence: mcp ? [] : ["MCP tools/call 真实响应"],
    },
    {
      goal: "http-comparison",
      status: mcp && http ? "sufficient" : mcp || http ? "partial" : "insufficient",
      missingEvidence: [
        ...(mcp ? [] : ["MCP tools/call 真实响应"]),
        ...(http ? [] : ["映射后直接 HTTP 响应"]),
      ],
    },
    {
      goal: "gateway-logs",
      status: logs?.ok ? "sufficient" : "insufficient",
      missingEvidence: logs?.ok
        ? []
        : [logs?.reason ?? "本次调用窗口的 MCP Service 日志"],
    },
  ];
}
