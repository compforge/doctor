import { mcpConfigurationProvider } from "./extensions";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { KubectlPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import type { CommandContext } from "../../command";
import { commandOutcome, resolveKubernetesCommandContext, type CommandResult } from "../../command";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import type { McpClient } from "../../infra/mcp";
import { openPluginContext, type ManagedPluginContext } from "../../plugin/context";
import { resolveApprovalGate } from "../../terminal/approval";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";

import { useLogger } from "../../terminal/log";
import { runCollect } from "../engine";
import { EvidenceBundle, type EvidenceStatus, type OutcomeDecl } from "../evidence";
import { evaluateCollectOutcome } from "../outcome";
import type { CoverageStatus } from "../protocol";
import { recordFailureBundle } from "../output/failure-bundle";
import { makeMcpConfigurationInspect, resolveMcpConfiguration } from "./configuration";
import { buildMcpCoverage, mcpDetectors } from "./detector";
import {
  buildMcpEvidence,
  type McpCommandContext,
  type McpDiagnosis,
  type McpFacts,
} from "./model";
import { parseMcpOutputFormat, resolveMcpOutputPath } from "./output";
import { mcpProbes } from "./probe";
import { renderMcpSummary } from "./render";

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

function coverageFromEvidenceStatus(status: EvidenceStatus | undefined): CoverageStatus {
  switch (status) {
    case "ok":
    case "unnecessary":
      return "sufficient";
    case "partial":
      return "partial";
    case "failed":
    case "skipped":
    case "unavailable":
    case undefined:
      return "insufficient";
  }
}

export async function runCollectMcp(
  opts: CollectMcpCliOptions,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): Promise<CommandResult<void>> {
  const timeoutMs = parseTimeout(opts.timeout);
  const format = parseMcpOutputFormat(opts.format);
  const { service, extension } = mcpConfigurationProvider(plugin.services, opts.gatewayService);
  const gatewayService = service.name;
  const collect = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!collect) return commandOutcome(130);
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
  resolveMcpOutputPath(opts.output, bundleName, format);
  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-mcp-"));
  const staging = join(stagingRoot, bundleName);
  commandContext.artifacts.add({ command: "mcp", path: staging });
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
    config: commandContext?.profile.pluginConfig,
    service,
    endpoint: extension.endpoint,
    command: "doctor mcp",
    capability: extension,
    authorization: access,
  });
  let configSourceKind: string | undefined;
  let facts: McpFacts | undefined;
  let diagnosis: McpDiagnosis | undefined;
  let failureReason: string | undefined;
  let client: McpClient | undefined;
  let gatewayContext: ManagedPluginContext | undefined;

  const finish = async (forcedCode?: number) => {
    await client?.close();
    for (const context of [pluginContext, gatewayContext]) {
      try {
        await context?.dispose();
      } catch (error) {
        useLogger("mcp").warn(`Context 清理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    bundle.writeSummary(
      diagnosis
        ? renderMcpSummary(diagnosis)
        : failedSummary(trace.traceId, failureReason ?? "配置确认或诊断流程未完成"),
    );
    if (diagnosis) writeFileSync(join(staging, "diagnosis.json"), `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
    bundle.writeManifest({
      doctorVersion: DOCTOR_CLI_VERSION,
      target: {
        namespace: collect.kubernetes.namespace,
        tenant: facts?.configuration.target.server.tenant,
        server: facts?.configuration.target.server.name,
        tool: facts?.configuration.target.tool.name,
        trace_id: trace.traceId,
      },
      inspectionFacts: facts
        ? {
          configured_tools: facts.configuration.configuredTools,
          runtime_tools: facts.configuration.runtimeTools,
          runtime_tools_error: facts.configuration.runtimeToolsError,
          gateway_pods: facts.configuration.gatewayPods,
        }
        : {},
      params: {
        kubeconfig_source: collect.kubernetes.kubeconfigSource,
        gateway_service: gatewayService,
        config_source_kind: configSourceKind,
        timeout_seconds: timeoutMs / 1000,
        output_format: format,
        argument_names: facts?.configuration.target.argumentNames ?? [],
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    const collectCode = forcedCode ?? evaluateCollectOutcome([...requiredEvidence].map((id) => {
      const status = bundle.getSteps().find((step) => step.id === id)?.status;
      return coverageFromEvidenceStatus(status);
    })).exitCode;
    if (collectCode === 130) {
      return 130;
    }
    if (collectCode !== 0) {
      recordFailureBundle({ bundleDir: staging, collectCode });
      return collectCode;
    }

    if (!diagnosis) {
      recordFailureBundle({ bundleDir: staging, collectCode: 1, reason: "成功产物生成失败" });
      return 1;
    }
    return 0;
  };

  try {
    const resolved = await resolveMcpConfiguration({
      namespace: collect.kubernetes.namespace,
      podLogs,
      pluginContext,
      bundle,
      selection: opts,
      gatewayService,
      extension,
      // Gateway probing is Command-owned access; configuration providers receive only their own grant.
      forwardGateway: async () => {
        gatewayContext = await openPluginContext(executor, {
          namespace: collect.kubernetes.namespace,
          kubeconfig: collect.kubernetes.kubeconfig,
          context: collect.kubernetes.context,
        }, {
          service, command: "doctor mcp gateway", authorization: access,
          capability: { access: { kubernetes: [{
            requirement: "required", rule: { verb: "create", resource: "pods/portforward" },
            purpose: "连接 MCP gateway 执行协议探测",
          }] } },
        });
        return gatewayContext.infra.kubernetes.portForward(extension.endpoint);
      },
      timeoutMs,
      traceId: trace.traceId,
      traceparent: trace.traceparent,
      writeArtifact,
    });
    if (!resolved) return commandOutcome(await finish(130));
    ({ configSourceKind, facts, client } = resolved);

    const ctx: McpCommandContext = {
      command: commandContext,
      config: resolved.config,
      executor,
      podLogs,
      bundle,
      client,
      approve: resolveApprovalGate(opts),
      startedAt,
      traceId: trace.traceId,
      requiredEvidence,
      writeArtifact,
    };
    const execution = await runCollect({
      ctx,
      config: resolved.config,
      inspects: [makeMcpConfigurationInspect(facts)],
      planProbes: () => mcpProbes,
      log: (line) => useLogger().info(`${line}`),
      buildEvidence: buildMcpEvidence,
      detectors: mcpDetectors,
      buildCoverage: buildMcpCoverage,
    });
    facts = execution.facts;
    diagnosis = execution.diagnosis;
    return commandOutcome(await finish());
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    useLogger("mcp").error(`${failureReason}`);
    bundle.settle(failureReason);
    return commandOutcome(await finish(1));
  }
}
