import { probeUnavailable, type Probe } from "../../protocol";
import { terminalStdout } from "../../../terminal/output";
import { executeHttpFromGatewayPod } from "../http";
import type {
  HttpCallObservation,
  McpCollectContext,
  McpDiagnosisConfig,
  McpFacts,
  McpObservation,
} from "../model";
import { approveProbeCall } from "./approval";

export const httpCallProbe: Probe<McpObservation, McpFacts, McpDiagnosisConfig, McpCollectContext> = {
  id: "http-call",
  evaluate: (facts) => facts.httpPlan
    ? { runnable: true }
    : probeUnavailable("Plugin 未提供该 tool 的直接 HTTP 映射"),
  onUnavailable: (ctx, reason) => {
    ctx.bundle.fill("http-response", { status: "unavailable", reason });
  },
  async run(ctx, facts, config) {
    const plan = facts.httpPlan;
    if (!plan) return [];
    const approved = await approveProbeCall(
      ctx,
      "direct-http-call",
      "在 MCP Service Pod 内直接重放映射后的 HTTP",
      plan.url,
      ["这是第二次真实下游 API 调用，可能重复写入或修改业务数据", "curl 与 Go http.Client 共享 Pod 网络/CA 文件，但实现并非完全相同"],
    );
    if (!approved) {
      ctx.bundle.fill("http-response", { status: "unavailable", reason: "未批准直接 HTTP 调用" });
      return [];
    }

    ctx.requiredEvidence.add("http-response");
    if (plan.unsupported.length) {
      ctx.bundle.fill("http-response", {
        status: "unavailable",
        reason: `HTTP 映射包含 doctor 暂不支持的规则：${plan.unsupported.join("; ")}`,
        output: "完整 request plan: http-request.json\n",
      });
      return [];
    }
    const pod = facts.gatewayPods[0];
    if (!pod) {
      ctx.bundle.fill("http-response", { status: "unavailable", reason: "没有可 exec 的 MCP Service Pod" });
      return [];
    }

    terminalStdout.write(`[mcp] 在 ${pod} 内执行直接 HTTP…\n`);
    const capture = await executeHttpFromGatewayPod(ctx.executor, pod, plan, config.timeoutMs);
    const responseFile = ctx.writeArtifact("http-response.txt", capture.rawResponse);
    const stderrFile = capture.stderr
      ? ctx.writeArtifact("http-stderr.txt", capture.stderr)
      : undefined;
    const statusOk = capture.statusCode === undefined || capture.statusCode < 400;
    const ok = capture.ok && statusOk;
    const reason = ok
      ? undefined
      : capture.stderr.trim().split("\n")[0]
        || (capture.statusCode ? `HTTP ${capture.statusCode}` : `exit=${capture.exitCode}`);
    ctx.bundle.fill("http-response", {
      status: ok ? "ok" : "failed",
      reason,
      command: capture.command,
      exitCode: capture.exitCode,
      durationMs: capture.durationMs,
      output: [
        "完整 request plan: http-request.json",
        `完整 HTTP response: ${responseFile}`,
        ...(stderrFile ? [`完整 curl stderr: ${stderrFile}`] : []),
      ].join("\n"),
    });
    const observation: HttpCallObservation = {
      id: "http-call",
      kind: "http-call",
      ok,
      capture,
    };
    return [observation];
  },
};
