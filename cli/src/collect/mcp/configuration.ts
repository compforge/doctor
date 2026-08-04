import { terminalStdout } from "../../terminal/output";
import { McpClient as RuntimeMcpClient, serializeMcpTranscript, type McpClient } from "../../infra/mcp";
import type { Executor } from "../../infra/k8s/executor";
import type { KubernetesPodLogAccess } from "../../infra/k8s/pod-log";
import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import type { McpConfigStorage, ServiceMcpCapability } from "@compforge/doctor-plugin";
import type { EvidenceBundle } from "../evidence";
import { renderHttpPlanAsCurl } from "./http";
import type { McpDiagnosisConfig, McpFacts } from "./model";
import type { McpCollectionPreparation } from "./preparation";
import { resolveToolArgs, selectServer, selectTool, type McpSelectionOptions } from "./selection";

export interface McpConfigurationInput {
  collect: KubernetesCommandConfig;
  executor: Executor;
  podLogs: KubernetesPodLogAccess;
  preparation: McpCollectionPreparation;
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
  configStorage: McpConfigStorage;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<{ payload: unknown; text: string; durationMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.trim().split("\n")[0]}`);
    return { payload: JSON.parse(text), text, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
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
    collect,
    executor,
    gatewayService,
    podLogs,
    preparation,
    selection,
    timeoutMs,
    traceId,
    traceparent,
    writeArtifact,
  } = input;

  terminalStdout.write(
    `[mcp] namespace: ${collect.kubernetes.namespace}\n`
    + `[mcp] 读取 configmap/${gatewayService} 的 Config Storage 配置…\n`,
  );
  const storageConfigResult = await executor.run(
    ["get", "configmap", gatewayService, "-o", "json"],
    { timeoutMs: 20_000 },
  );
  let configStorage: McpConfigStorage | undefined;
  let storageConfigError: string | undefined;
  if (storageConfigResult.ok) {
    try {
      configStorage = capability.parseConfigStorage(storageConfigResult.stdout);
    } catch (error) {
      storageConfigError = error instanceof Error ? error.message : String(error);
    }
  } else {
    storageConfigError = storageConfigResult.stderr.trim()
      || `读取 configmap/${gatewayService} 失败（exit=${storageConfigResult.exitCode}）`;
  }
  bundle.addStep({
    id: "config-storage-config",
    title: `读取 ${gatewayService} Config Storage 配置`,
    risk: "observe",
    status: configStorage ? "ok" : "failed",
    reason: storageConfigError,
    command: storageConfigResult.command,
    durationMs: storageConfigResult.durationMs,
    output: configStorage
      ? `type=${configStorage.type}\nurl=${configStorage.url}\n`
      : undefined,
    stderr: storageConfigResult.stderr,
  });
  if (!configStorage) {
    const reason = storageConfigError ?? "Config Storage 配置不可用";
    bundle.fill("mcp-config", { status: "unavailable", reason });
    throw new Error(reason);
  }
  terminalStdout.write(`[mcp] Config Storage: ${configStorage.type} ${configStorage.url}\n`);

  let storageEndpoint;
  let storageAccessError: string | undefined;
  try {
    storageEndpoint = await preparation.forwardUrl(configStorage.url);
  } catch (error) {
    storageAccessError = error instanceof Error ? error.message : String(error);
  }
  bundle.addStep({
    id: "config-storage-access",
    title: "准备 Config Storage API 访问",
    risk: "observe",
    status: storageEndpoint ? "ok" : "failed",
    reason: storageAccessError,
    command: storageEndpoint?.command,
  });
  if (!storageEndpoint) {
    const reason = storageAccessError ?? `无法访问 ${configStorage.url}`;
    bundle.fill("mcp-config", { status: "unavailable", reason });
    throw new Error(`Config Storage URL 请求失败：${reason}`);
  }

  let storageResponse: Awaited<ReturnType<typeof fetchJson>>;
  try {
    storageResponse = await fetchJson(storageEndpoint.url, timeoutMs);
  } catch (error) {
    const fetchReason = error instanceof Error ? error.message : String(error);
    const reason = `GET ${configStorage.url}: ${fetchReason}`;
    bundle.fill("mcp-config", { status: "failed", reason });
    throw new Error(`Config Storage URL 请求失败：${reason}`);
  }
  const choices = capability.listServers(storageResponse.payload);
  const configFile = writeArtifact(
    "mcp-config.json",
    storageResponse.text.endsWith("\n") ? storageResponse.text : `${storageResponse.text}\n`,
  );
  bundle.fill("mcp-config", {
    status: "ok",
    durationMs: storageResponse.durationMs,
    output: `完整 Config Storage response: ${configFile}\nservers=${choices.length}\n`,
  });

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
    gatewayEndpoint = await preparation.forwardService(gatewayService, capability.endpoint.port);
  } catch (error) {
    runtimeToolsError = error instanceof Error ? error.message : String(error);
  }
  bundle.addStep({
    id: "gateway-port-forward",
    title: `${gatewayService} port-forward`,
    risk: "observe",
    status: gatewayEndpoint ? "ok" : "failed",
    reason: runtimeToolsError,
    command: gatewayEndpoint?.command,
  });
  if (gatewayEndpoint) {
    client = new RuntimeMcpClient({
      endpoint: `http://${gatewayEndpoint.host}:${gatewayEndpoint.port}${server.runtimePath}`,
      transport: "sse",
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
    const httpPlan = tool.buildHttpRequest(args);
    writeArtifact("http-request.json", `${JSON.stringify(httpPlan, null, 2)}\n`);
    let httpCurl: string | undefined;
    if (httpPlan.unsupported.length) {
      bundle.fill("http-curl", {
        status: "unavailable",
        reason: `HTTP 映射包含 doctor 暂不支持的规则：${httpPlan.unsupported.join("; ")}`,
      });
    } else {
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
      configStorage,
    };
  } catch (error) {
    await client?.close();
    throw error;
  }
}
