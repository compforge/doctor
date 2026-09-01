import { httpCallObservation, mcpCallObservation } from "../model";
import type { McpDetector, McpFinding } from "./types";

const FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "mcp-path-comparison" },
};

function callEvidence(): McpFinding["evidence"] {
  return [
    { observationId: "mcp-call", role: "supporting" },
    { observationId: "http-call", role: "supporting" },
  ];
}

/**
 * 这里只判断两条调用路径的成败组合，不比较响应正文是否等价。
 * Config 映射到 curl 的实现与网关内部请求仍可能存在边界差异，正文相异本身不能证明故障归属。
 */
export const compareMcpAndHttp: McpDetector = (evidence) => {
  const mcp = mcpCallObservation(evidence);
  const http = httpCallObservation(evidence);
  if (!mcp || !http) return [];

  if (!mcp.ok && http.ok) {
    return [{
      ...FINDING_META,
      id: "mcp-protocol-path-failure",
      kind: "mcp.protocol-path-failure",
      severity: "warning",
      confidence: "medium",
      evidence: callEvidence(),
      summary: "直接 HTTP 成功而 MCP 调用失败，问题更接近 MCP session、gateway 协议处理或 tool 映射链路。",
    }];
  }
  if (!mcp.ok && !http.ok) {
    return [{
      ...FINDING_META,
      id: "mcp-common-downstream-failure",
      kind: "mcp.common-downstream-failure",
      severity: "warning",
      confidence: "medium",
      evidence: callEvidence(),
      summary: "MCP 与直接 HTTP 均失败，共同的下游地址、认证、网络或服务状态更值得优先检查。",
    }];
  }
  if (mcp.ok && !http.ok) {
    return [{
      ...FINDING_META,
      id: "mcp-http-replay-divergence",
      kind: "mcp.http-replay-divergence",
      severity: "info",
      confidence: "medium",
      evidence: callEvidence(),
      summary: "MCP 调用成功而直接 HTTP 失败，doctor 生成的 HTTP 重放可能未覆盖网关运行时的全部映射语义。",
    }];
  }
  return [];
};
