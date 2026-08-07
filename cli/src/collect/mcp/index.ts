import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { McpClient } from "../../infra/mcp";
import { KubectlPodLogAccess } from "../../infra/k8s/pod-log";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { runDiagnosis } from "../engine";
import { EvidenceBundle, type OutcomeDecl } from "../evidence";
import { packBundle } from "../output/archive";
import { deliverFailureBundle } from "../output/failure-bundle";
import { writeHtmlReport } from "../output/html";
import { evaluateCollectOutcome } from "../outcome";
import { resolveApprovalGate } from "../../terminal/approval";
import { openPluginContext } from "../../plugin/context";
import { resolveMcpConfiguration } from "./configuration";
import { buildMcpCoverage, mcpDetectors } from "./detector";
import { buildMcpEvidence, type McpDiagnosis, type McpFacts } from "./model";
import { parseMcpOutputFormat, resolveMcpOutputPath } from "./output";
import { mcpProbes } from "./probe";
import { buildMcpReportHtml, renderMcpSummary } from "./render";

export interface CollectMcpCliOptions {
  namespace?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  server?: string;
  tool?: string;
  args?: string;
  argsFile?: string;
  timeout?: string;
  gatewayService?: string;
  yes?: boolean;
  format?: string;
  output?: string;
}

const MCP_OUTCOMES: readonly OutcomeDecl[] = [
  { id: "mcp-config", title: "Plugin MCP 配置投影", risk: "observe" },
  { id: "mcp-tools", title: "MCP tools/list 真实响应", risk: "observe" },
  { id: "mcp-response", title: "MCP tools/call 真实响应", risk: "disrupt" },
  { id: "http-curl", title: "映射 HTTP 请求的复现 cURL", risk: "observe" },
  { id: "http-response", title: "MCP Service Pod 内直接 HTTP 响应", risk: "disrupt" },
  { id: "gateway-logs", title: "本次执行窗口 MCP Service 日志", risk: "observe" },
] as const;

export function defaultMcpBundleName(now: Date): string {
  const p = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `doctor-mcp-${timestamp}`;
}

function parseTimeout(raw: string | undefined): number {
  const seconds = Number(raw ?? "60");
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error("--timeout 必须是 1..600 秒");
  }
  return Math.floor(seconds * 1000);
}

function traceContext(): { traceId: string; traceparent: string } {
  const traceId = randomBytes(16).toString("hex");
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` };
}

function failedSummary(traceId: string, reason: string): string {
  return [
    "# doctor mcp",
    "",
    `- trace_id: ${traceId}`,
    `- status: failed`,
    `- reason: ${reason}`,
    "",
    "已取得的原始证据与失败步骤见 manifest.json 和 raw/。",
    "",
  ].join("\n");
}

export async function runCollectMcp(
  opts: CollectMcpCliOptions,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
): Promise<number> {
  const timeoutMs = parseTimeout(opts.timeout);
  const format = parseMcpOutputFormat(opts.format);
  const mcpServices = plugin.services.servicesWith("mcp");
  const service = opts.gatewayService
    ? plugin.services.findWith(opts.gatewayService, "mcp")
    : mcpServices.length === 1 ? mcpServices[0] : undefined;
  if (!service) {
    if (opts.gatewayService) {
      throw new Error(`Plugin '${plugin.id}' 的 Service '${opts.gatewayService}' 未声明 mcp 能力`);
    }
    if (!mcpServices.length) throw new Error(`Plugin '${plugin.id}' 未声明 mcp 能力`);
    throw new Error(`Plugin '${plugin.id}' 声明了多个 mcp Service，请通过 --gateway-service 指定`);
  }
  const gatewayService = service.name;
  const capability = service.capabilities.mcp;
  const collect = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!collect) return 130;
  const executor = createKubernetesExecutor(collect);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(access, {
    command: "doctor mcp",
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析 MCP gateway Service",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "定位 gateway Pod",
    }, {
      requirement: "required",
      rule: { verb: "get", resource: "pods/log" },
      purpose: "采集本次 MCP 调用窗口的 gateway 日志",
    }, {
      requirement: "preferred",
      rule: { verb: "create", resource: "pods/portforward" },
      purpose: "从 Doctor Host 访问 Plugin 配置源与 MCP endpoint",
      fallback: "仅当配置 endpoint 可由 Doctor Host 直连时可继续",
    }],
  });
  const podLogs = new KubectlPodLogAccess(executor, collect.kubernetes.namespace);
  const startedAt = new Date().toISOString();
  const bundleName = defaultMcpBundleName(new Date());
  const outputPath = resolveMcpOutputPath(opts.output, bundleName, format);
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-mcp-"));
  const staging = join(stagingRoot, bundleName);
  const bundle = new EvidenceBundle(staging, MCP_OUTCOMES);
  const trace = traceContext();
  const requiredEvidence = new Set(["mcp-config", "mcp-tools", "gateway-logs"]);
  const writeArtifact = (name: string, content: string) => {
    writeFileSync(join(staging, name), content, "utf-8");
    return name;
  };
  const pluginContext = await openPluginContext(executor, {
    namespace: collect.kubernetes.namespace,
    kubeconfig: collect.kubernetes.kubeconfig,
    context: collect.kubernetes.context,
  }, {
    env: collect.profileName,
    config: commandContext?.profile.pluginConfig,
    service: { name: gatewayService, port: capability.endpoint.port },
    command: "doctor mcp",
    capability,
    authorization: access,
  });
  let configSourceKind: string | undefined;
  let facts: McpFacts | undefined;
  let diagnosis: McpDiagnosis | undefined;
  let failureReason: string | undefined;
  let client: McpClient | undefined;

  const finish = async (forcedCode?: number) => {
    await client?.close();
    try {
      await pluginContext.dispose();
    } catch (error) {
      terminalStderr.warning(
        `[mcp] Plugin context 清理失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    bundle.writeSummary(
      diagnosis
        ? renderMcpSummary(diagnosis)
        : failedSummary(trace.traceId, failureReason ?? "配置确认或诊断流程未完成"),
    );
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: {
        namespace: collect.kubernetes.namespace,
        tenant: facts?.target.server.tenant,
        server: facts?.target.server.name,
        tool: facts?.target.tool.name,
        trace_id: trace.traceId,
      },
      inspectionFacts: facts
        ? {
          configured_tools: facts.configuredTools,
          runtime_tools: facts.runtimeTools,
          runtime_tools_error: facts.runtimeToolsError,
          gateway_pods: facts.gatewayPods,
        }
        : {},
      params: {
        kubeconfig_source: collect.kubernetes.kubeconfigSource,
        gateway_service: gatewayService,
        config_source_kind: configSourceKind,
        timeout_seconds: timeoutMs / 1000,
        output_format: format,
        argument_names: facts?.target.argumentNames ?? [],
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    const collectCode = forcedCode ?? evaluateCollectOutcome([...requiredEvidence].map((id) =>
      bundle.getSteps().some((step) =>
        step.id === id && (step.status === "ok" || step.status === "unnecessary")
      )
    )).exitCode;
    if (collectCode === 130) {
      rmSync(stagingRoot, { recursive: true, force: true });
      return 130;
    }
    if (collectCode !== 0) {
      const failure = await deliverFailureBundle({
        bundleDir: staging,
        bundleName,
        requestedOutput: opts.output,
        collectCode,
      });
      if (failure.packed.ok) {
        rmSync(stagingRoot, { recursive: true, force: true });
        terminalStderr.error(`[mcp] 采集失败，Evidence Bundle: ${failure.path}\n`);
        return collectCode;
      }
      terminalStderr.error(`[mcp] 失败 Bundle 打包失败，原始证据保留在: ${staging}\n`);
      return 1;
    }

    let delivered = false;
    if (format === "html" && diagnosis) {
      try {
        writeHtmlReport(staging, outputPath, {
          title: "doctor MCP 诊断报告",
          profileName: collect.profileName,
          summaryHtml: buildMcpReportHtml(diagnosis),
        });
        delivered = true;
      } catch (error) {
        terminalStderr.error(`[mcp] HTML 生成失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
    } else if (format === "bundle") {
      const packed = await packBundle(staging, outputPath);
      delivered = packed.ok;
      if (!packed.ok) {
        terminalStderr.error(`[mcp] Bundle 打包失败：${packed.stderr.trim() || `exit=${packed.exitCode}`}\n`);
      }
    }
    if (delivered) {
      chmodSync(outputPath, 0o600);
      rmSync(stagingRoot, { recursive: true, force: true });
      terminalStdout.success(`[mcp] ${format === "html" ? "HTML 报告" : "Evidence Bundle"}: ${outputPath}\n`);
      return 0;
    }
    const failure = await deliverFailureBundle({
      bundleDir: staging,
      bundleName,
      requestedOutput: opts.output,
      collectCode: 1,
      reason: "成功产物生成失败",
    });
    if (failure.packed.ok) {
      rmSync(stagingRoot, { recursive: true, force: true });
      terminalStderr.error(`[mcp] 成功产物生成失败，Evidence Bundle: ${failure.path}\n`);
    } else {
      terminalStderr.error(`[mcp] 交付文件生成不完整，原始证据保留在: ${staging}\n`);
    }
    return 1;
  };

  try {
    const resolved = await resolveMcpConfiguration({
      namespace: collect.kubernetes.namespace,
      podLogs,
      pluginContext,
      bundle,
      selection: opts,
      gatewayService,
      capability,
      timeoutMs,
      traceId: trace.traceId,
      traceparent: trace.traceparent,
      writeArtifact,
    });
    if (!resolved) return await finish(130);
    ({ configSourceKind, facts, client } = resolved);

    diagnosis = await runDiagnosis({
      ctx: {
        executor,
        podLogs,
        bundle,
        client,
        approve: resolveApprovalGate(opts),
        startedAt,
        traceId: trace.traceId,
        requiredEvidence,
        writeArtifact,
      },
      facts,
      config: resolved.config,
      probes: mcpProbes,
      log: (line) => terminalStdout.write(`${line}\n`),
      buildEvidence: buildMcpEvidence,
      detectors: mcpDetectors,
      buildCoverage: buildMcpCoverage,
    });
    return await finish();
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    terminalStderr.error(`[mcp] ${failureReason}\n`);
    bundle.settle(failureReason);
    return await finish(1);
  }
}
