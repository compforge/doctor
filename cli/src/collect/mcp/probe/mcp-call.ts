import type { Probe } from "../../protocol";
import { serializeMcpTranscript } from "../../../infra/mcp";
import { terminalStdout } from "../../../terminal/output";
import type {
  McpCallObservation,
  McpCommandContext,
  McpDiagnosisConfig,
  McpFacts,
  McpObservation,
} from "../model";
import { approveProbeCall } from "./approval";

export const mcpCallProbe: Probe<McpObservation, McpFacts, McpDiagnosisConfig, McpCommandContext> = {
  id: "mcp-call",
  evaluate: () => ({ runnable: true }),
  async run(ctx, facts, config) {
    const approved = await approveProbeCall(
      ctx,
      "mcp-tool-call",
      "通过 MCP 协议执行所选 tool",
      `${facts.configuration.target.server.id}/${facts.configuration.target.tool.name}`,
      ["会真实调用下游 API，可能写入或修改业务数据", "随后直接 HTTP 重放会形成第二次独立调用"],
    );
    if (!approved) {
      ctx.bundle.fill("mcp-response", { status: "unavailable", reason: "未批准 MCP tool call" });
      return [];
    }

    ctx.requiredEvidence.add("mcp-response");
    if (!ctx.client) {
      ctx.bundle.fill("mcp-response", {
        status: "unavailable",
        reason: facts.configuration.runtimeToolsError ?? "MCP session 未建立",
      });
      return [];
    }

    terminalStdout.write(`[mcp] 执行 MCP tools/call: ${facts.configuration.target.tool.name}…\n`);
    const rawCapture = await ctx.client.callTool(facts.configuration.target.tool.name, config.args);
    const capture = {
      ...rawCapture,
      transcript: serializeMcpTranscript(ctx.client.transcript),
    };
    const rpcError = capture.response?.error === undefined
      ? undefined
      : JSON.stringify(capture.response.error);
    const result = capture.response?.result as { isError?: boolean } | undefined;
    const toolError = result?.isError ? "MCP tool result 标记 isError=true" : undefined;
    const reason = capture.error ?? rpcError ?? toolError;
    const responseFile = capture.response
      ? ctx.writeArtifact("mcp-response.json", `${JSON.stringify(capture.response, null, 2)}\n`)
      : undefined;
    const transcriptFile = ctx.writeArtifact("mcp-transcript.jsonl", capture.transcript);
    ctx.bundle.fill("mcp-response", {
      status: capture.response && !reason ? "ok" : "failed",
      reason,
      durationMs: capture.durationMs,
      output: [
        responseFile ? `完整 JSON-RPC response: ${responseFile}` : "JSON-RPC response: unavailable",
        `完整 SSE transcript: ${transcriptFile}`,
      ].join("\n"),
    });
    const observation: McpCallObservation = {
      id: "mcp-call",
      kind: "mcp-call",
      schemaVersion: 1,
      producer: { origin: "core", id: "mcp-call" },
      ok: !!capture.response && !reason,
      durationMs: capture.durationMs,
      response: capture.response,
      error: reason,
    };
    return [observation];
  },
};
