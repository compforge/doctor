import { terminalStdout } from "../../terminal/output";
import { McpClient as RuntimeMcpClient, serializeMcpTranscript, type McpClient } from "../../infra/mcp";
import type { KubernetesPodLogAccess } from "../../infra/k8s/pod-log";
import type {
  McpConfigurationProjection,
  PluginContext,
  ServiceMcpCapability,
} from "@compforge/doctor-plugin";
import type { EvidenceBundle } from "../evidence";
import { renderHttpPlanAsCurl } from "./http";
import type { McpDiagnosisConfig, McpFacts } from "./model";
import { resolveToolArgs, selectServer, selectTool, type McpSelectionOptions } from "./selection";

export interface McpConfigurationInput {
  namespace: string;
  podLogs: KubernetesPodLogAccess;
  pluginContext: PluginContext;
  bundle: EvidenceBundle;
  selection: McpSelectionOptions;
  gatewayService: string;
  capability: ServiceMcpCapability;
  timeoutMs: number;
  traceId: string;
  traceparent: string;
  writeArtifact: (name: string, content: string) => string;
}

export interface ResolvedMcpConfiguration {
  config: McpDiagnosisConfig;
  facts: McpFacts;
  client?: McpClient;
  configSourceKind: string;
}

async function listRuntimeTools(client: McpClient) {
  try {
    await client.connect();
    const listed = await client.listTools();
    return {
      ok: true as const,
      names: listed.tools.map((tool) => tool.name),
      response: listed.response,
    };
  } catch (error) {
    return {
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
      transcript: serializeMcpTranscript(client.transcript),
    };
  }
}

/**
 * 确认本次诊断使用的动态配置与目标。tools/list 属于这里而不是 Probe：在不知道
 * gateway 实际暴露哪些 tools 前，用户无法可靠确定后续 MCP/HTTP Probe 的共同目标。
 */
export async function resolveMcpConfiguration(
  input: McpConfigurationInput,
): Promise<ResolvedMcpConfiguration | undefined> {
  const {
    bundle,
    capability,
    gatewayService,
    namespace,
    podLogs,
    pluginContext,
    selection,
    timeoutMs,
    traceId,
    traceparent,
    writeArtifact,
  } = input;

  terminalStdout.write(
    `[mcp] namespace: ${namespace}\n`
    + `[mcp] 通过 ${gatewayService} Plugin capability 加载 MCP 配置…\n`,
  );
  const configStartedAt = Date.now();
  let projection: McpConfigurationProjection;
  try {
    projection = await capability.loadConfiguration(pluginContext, { timeoutMs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.fill("mcp-config", { status: "failed", reason });
    throw error;
  }
  bundle.fill("mcp-config", {
    status: "ok",
    durationMs: Date.now() - configStartedAt,
    output: `source_kind=${projection.sourceKind}\nservers=${projection.servers.length}\n`,
  });

  const choices = projection.servers;
  if (!choices.length) throw new Error("MCP 配置中没有可用 server");
  const server = await selectServer(choices, selection.server);
  if (!server) return undefined;
  const configuredTools = server.tools.map((tool) => tool.name);

  const gatewayServicePods = await podLogs.listServicePods([gatewayService]);
  const pods = gatewayServicePods.podCapture;
  const gatewayPods = pods.ok && gatewayServicePods.serviceCapture.ok && !gatewayServicePods.parseError
    ? gatewayServicePods.byService[gatewayService] ?? []
    : [];
  bundle.addStep({
    id: "gateway-service-list",
    title: `解析 ${gatewayService} Service selector`,
    risk: "observe",
    status: gatewayServicePods.serviceCapture.ok && !gatewayServicePods.parseError ? "ok" : "failed",
    reason: gatewayServicePods.parseError
      ?? (gatewayServicePods.serviceCapture.ok
        ? undefined
        : gatewayServicePods.serviceCapture.stderr.trim().split("\n")[0]),
    command: gatewayServicePods.serviceCapture.command,
    output: gatewayServicePods.serviceCapture.stdout,
    stderr: gatewayServicePods.serviceCapture.stderr,
  });
  bundle.addStep({
    id: "gateway-pods",
    title: `定位 ${gatewayService} Pods`,
    risk: "observe",
    status: pods.ok && gatewayPods.length ? "ok" : "unavailable",
    reason: pods.ok
      ? gatewayPods.length ? undefined : "没有运行中的 gateway Pod"
      : pods.stderr.trim().split("\n")[0],
    command: pods.command,
    output: gatewayPods.join("\n"),
    stderr: pods.stderr,
  });

  let client: McpClient | undefined;
  let runtimeTools: string[] = [];
  let runtimeToolsError: string | undefined;
  let gatewayEndpoint;
  try {
    gatewayEndpoint = await pluginContext.infra.kubernetes.portForward({
      host: gatewayService,
      port: capability.endpoint.port,
    });
  } catch (error) {
    runtimeToolsError = error instanceof Error ? error.message : String(error);
  }
  bundle.addStep({
    id: "gateway-port-forward",
    title: `${gatewayService} port-forward`,
    risk: "observe",
    status: gatewayEndpoint ? "ok" : "failed",
    reason: runtimeToolsError,
  });
  if (gatewayEndpoint) {
    client = new RuntimeMcpClient({
      endpoint: `http://${gatewayEndpoint.host}:${gatewayEndpoint.port}${server.connection.path}`,
      transport: server.connection.transport,
      headers: { traceparent },
      timeoutMs,
    });
    terminalStdout.write("[mcp] 建立 SSE session 并执行 tools/list…\n");
    const toolsResult = await listRuntimeTools(client);
    if (toolsResult.ok) {
      runtimeTools = toolsResult.names;
      const toolsFile = writeArtifact("mcp-tools-list.json", `${JSON.stringify(toolsResult.response, null, 2)}\n`);
      bundle.fill("mcp-tools", {
        status: "ok",
        output: `完整 JSON-RPC response: ${toolsFile}\nruntime_tools=${runtimeTools.length}\n`,
      });
    } else {
      runtimeToolsError = toolsResult.reason;
      const transcriptFile = writeArtifact("mcp-transcript.jsonl", toolsResult.transcript);
      bundle.fill("mcp-tools", {
        status: "failed",
        reason: toolsResult.reason,
        output: `完整 SSE transcript: ${transcriptFile}\n`,
      });
      await client.close();
      client = undefined;
    }
  } else {
    bundle.fill("mcp-tools", {
      status: "unavailable",
      reason: runtimeToolsError ?? "gateway port-forward 失败",
    });
  }

  try {
    const tool = await selectTool(server.tools, runtimeTools.map((name) => ({ name })), selection.tool);
    if (!tool) {
      await client?.close();
      return undefined;
    }
    const args = await resolveToolArgs(selection, tool);
    const httpPlan = tool.buildHttpRequest?.(args);
    let httpCurl: string | undefined;
    if (!httpPlan) {
      bundle.fill("http-curl", {
        status: "unavailable",
        reason: "Plugin 未提供该 tool 的直接 HTTP 映射",
      });
    } else if (httpPlan.unsupported.length) {
      writeArtifact("http-request.json", `${JSON.stringify(httpPlan, null, 2)}\n`);
      bundle.fill("http-curl", {
        status: "unavailable",
        reason: `HTTP 映射包含 doctor 暂不支持的规则：${httpPlan.unsupported.join("; ")}`,
      });
    } else {
      writeArtifact("http-request.json", `${JSON.stringify(httpPlan, null, 2)}\n`);
      httpCurl = renderHttpPlanAsCurl(httpPlan);
      const curlFile = writeArtifact("http-request.curl", httpCurl);
      bundle.fill("http-curl", { status: "ok", output: `可复制执行的 cURL: ${curlFile}\n` });
    }

    return {
      config: { timeoutMs, args },
      facts: {
        traceId,
        target: { server, tool, argumentNames: Object.keys(args) },
        configuredTools,
        runtimeTools,
        runtimeToolsError,
        gatewayPods,
        httpPlan,
        httpCurl,
      },
      client,
      configSourceKind: projection.sourceKind,
    };
  } catch (error) {
    await client?.close();
    throw error;
  }
}
