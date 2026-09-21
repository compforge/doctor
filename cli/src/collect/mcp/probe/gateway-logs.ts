import type { Probe } from "../../protocol";
import { probeUnavailable } from "../../protocol";

import { useLogger } from "../../../terminal/log";
import { collectGatewayLogs } from "../http";
import type {
  GatewayLogsObservation,
  McpCommandContext,
  McpDiagnosisConfig,
  McpFacts,
  McpObservation,
} from "../model";

export const gatewayLogsProbe: Probe<McpObservation, McpFacts, McpDiagnosisConfig, McpCommandContext> = {
  id: "gateway-logs",
  dependsOn: ["mcp-call", "http-call"],
  evaluate: (facts) => facts.configuration.gatewayPods.length
    ? { runnable: true }
    : probeUnavailable("没有运行中的 MCP Service Pod"),
  onUnavailable: (ctx, reason) => {
    ctx.bundle.fill("gateway-logs", { status: "unavailable", reason });
  },
  async run(ctx, facts) {
    useLogger("mcp").info("收集本次窗口 MCP Service 日志…");
    const logs = await collectGatewayLogs(
      ctx.podLogs,
      facts.configuration.gatewayPods,
      ctx.startedAt,
      ctx.traceId,
      facts.configuration.target.tool.name,
    );
    const logsFile = ctx.writeArtifact("mcp-service-logs.txt", logs.output);
    const matchedLines = logs.output.split(/\r?\n/)
      .filter((line) => line && !line.startsWith("---") && !line.startsWith("(")).length;
    ctx.bundle.fill("gateway-logs", {
      status: logs.ok ? "ok" : "failed",
      reason: logs.reason,
      command: logs.command,
      durationMs: logs.durationMs,
      output: `完整匹配日志: ${logsFile}\nmatched_lines=${matchedLines}\n`,
    });
    const observation: GatewayLogsObservation = {
      id: "gateway-logs",
      kind: "gateway-logs",
      schemaVersion: 1,
      producer: { origin: "core", id: "gateway-logs" },
      ok: logs.ok,
      matchedLines,
      reason: logs.reason,
    };
    return [observation];
  },
};
