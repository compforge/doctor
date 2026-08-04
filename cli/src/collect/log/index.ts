import { terminalStdout, terminalStderr } from "../../terminal/output";
// log collect 编排：配置确认 → Inspect → 每 Service 一个 Probe → Render。
// Kubernetes 的 Pod 枚举和日志读取由 infra/k8s 提供；本目录只保留业务选择和证据语义。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { resolveWorkingProfileName } from "../../app/profile";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import { resolveCollectKubeconfig, resolveCollectNamespace } from "../../infra/k8s/context";
import { KubectlExecutor, type Executor } from "../../infra/k8s/executor";
import { resolvePodNamespace } from "../../infra/k8s/namespace-selection";
import { KubectlPodLogAccess } from "../../infra/k8s/pod-log";
import { runInspects } from "../inspect-engine";
import { runProbes } from "../probe-engine";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { EvidenceBundle } from "../evidence";
import { packBundle } from "../output/archive";
import { deliverFailureBundle } from "../output/failure-bundle";
import { evaluateCollectOutcome } from "../outcome";
import {
  enforceKubernetesAccess,
  requireKubernetesChannel,
} from "../../terminal/kubernetes-access";
import {
  buildLogPattern,
  resolveLogTimeWindow,
  resolveLogServiceSelection,
} from "./config";
import { makeLogInspect } from "./fact/inspect";
import type { LogCollectOptions, LogInspectionFacts, LogProbeConfig } from "./model";
import { makeServiceLogProbe } from "./probe/service";
import { renderLogResult, renderTimelineJsonl } from "./render";
import { parseLogOutputFormat, resolveLogOutputPath } from "./output";
import type { LogOutputFormat } from "./output";
import { writeLogHtmlReport } from "./html";
import { resolveDataIdentifier } from "../data/identifier";

export * from "./config";
export * from "./html";
export * from "./model";
export * from "./output";
export * from "./probe/service";
export * from "./render";
export interface CollectLogCliOpts {
  bizId: string;
  namespace?: string;
  services?: string;
  since?: string;
  sinceTime?: string;
  errorsOnly?: boolean;
  pattern?: string;
  format?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

export function defaultLogBundleName(traceId: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `doctor-log-${traceId.slice(0, 12)}-${ts}`;
}

export async function runCollectLog(
  opts: CollectLogCliOpts,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
): Promise<number> {
  let pattern: RegExp | undefined;
  let format: LogOutputFormat;
  try {
    pattern = buildLogPattern(!!opts.errorsOnly, opts.pattern);
    format = parseLogOutputFormat(opts.format);
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  let resolved;
  let configuredNamespace;
  try {
    resolved = resolveCollectKubeconfig(opts);
    configuredNamespace = resolveCollectNamespace(opts);
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (resolved.source.startsWith("profile:")) {
    terminalStdout.write(`[collect] kubeconfig 来自 ${resolved.source}（${resolved.kubeconfig}）\n`);
  }
  const channelExecutor = new KubectlExecutor({
    kubeconfig: resolved.kubeconfig,
    context: opts.context,
  });
  const bootstrapKubernetes = resolveKubernetesCommandContext(channelExecutor, commandContext);
  await requireKubernetesChannel({
    executor: channelExecutor,
    profileName: resolveWorkingProfileName(opts),
    kubeconfigSource: resolved.source,
    commandContext,
  });
  const resolvedNamespace = await resolvePodNamespace({
    resolved: configuredNamespace,
    kubeconfig: resolved.kubeconfig,
    context: opts.context,
    executor: channelExecutor,
    access: bootstrapKubernetes.access,
  });
  if (!resolvedNamespace) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  terminalStdout.write(`[collect] namespace: ${resolvedNamespace.namespace}（${resolvedNamespace.source}）\n`);

  const executor = new KubectlExecutor({
    namespace: resolvedNamespace.namespace,
    kubeconfig: resolved.kubeconfig,
    context: opts.context,
  });
  await enforceKubernetesAccess(resolveKubernetesCommandContext(executor, commandContext).access, {
    command: "doctor log",
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析待采集日志的 Service",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "定位每个 Service 的 Running Pod",
    }, {
      requirement: "required",
      rule: { verb: "get", resource: "pods/log" },
      purpose: "读取 current/previous Container 日志",
    }, {
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "读取业务 ID expander 的 Service 运行时配置",
    }, {
      requirement: "required",
      rule: { verb: "create", resource: "pods/portforward" },
      purpose: "访问 Plugin 声明的业务 ID 数据源",
    }],
  });
  let trace;
  try {
    trace = await resolveDataIdentifier({
      inputId: opts.bizId,
      identifier: "trace_id",
      namespace: resolvedNamespace.namespace,
      kubeconfig: resolved.kubeconfig,
      context: opts.context,
      profile: opts.profile,
      config: opts.config,
    }, plugin, executor);
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!trace) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  terminalStdout.write(
    `[collect] biz-id: ${opts.bizId} → trace-id: ${trace.value}`
    + `（${trace.service} 按 ${trace.resolvedAs} 解析）\n`,
  );
  let services: string[] | undefined;
  try {
    services = await resolveLogServiceSelection({
      raw: opts.services,
      namespace: resolvedNamespace.namespace,
      catalog: plugin.services,
      executor,
      kubeconfig: resolved.kubeconfig,
      context: opts.context,
    });
  } catch (err) {
    terminalStderr.error(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (!services) {
    terminalStderr.warning("[collect] 已取消\n");
    return 130;
  }
  terminalStdout.write(`[collect] services: ${services.join(", ")}\n`);

  const timeWindow = resolveLogTimeWindow({
    id: opts.bizId,
    since: opts.since,
    sinceTime: opts.sinceTime,
  });
  if (!opts.since && !opts.sinceTime && timeWindow.sinceTime) {
    terminalStdout.write(`[collect] 从 UUIDv7 ID 推导日志起点: ${timeWindow.sinceTime}\n`);
  }

  const bundleName = defaultLogBundleName(trace.value, new Date());
  let outputPath: string;
  try {
    outputPath = resolveLogOutputPath(opts.output, bundleName, format);
  } catch (error) {
    terminalStderr.error(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const staging = join(mkdtempSync(join(tmpdir(), "doctor-collect-")), bundleName);
  const code = await collectLog(
    {
      bizId: opts.bizId,
      traceId: trace.value,
      namespace: resolvedNamespace.namespace,
      services,
      since: timeWindow.since,
      sinceTime: timeWindow.sinceTime,
      errorsOnly: !!opts.errorsOnly,
      pattern: opts.pattern,
      outputDir: staging,
    },
    executor,
    (line) => terminalStdout.write(`${line}\n`),
    pattern,
  );
  let reportError: string | undefined;
  const reportPath = format === "html" && code === 0
    ? outputPath
    : join(staging, "report.html");
  try {
    writeLogHtmlReport(
      staging,
      reportPath,
      resolveWorkingProfileName(opts),
    );
  } catch (error) {
    reportError = error instanceof Error ? error.message : String(error);
    terminalStderr.error(`[collect] Log HTML 生成失败：${reportError}\n`);
  }
  if (code === 0 && !reportError && format === "html") {
    rmSync(join(staging, ".."), { recursive: true, force: true });
    terminalStdout.success(`[collect] Log HTML 报告: ${outputPath}\n`);
    return 0;
  }
  const delivery = code === 0 && !reportError
    ? { path: outputPath, packed: await packBundle(staging, outputPath) }
    : await deliverFailureBundle({
        bundleDir: staging,
        bundleName,
        requestedOutput: opts.output,
        collectCode: code || 1,
        reason: reportError,
      });
  const { packed } = delivery;
  if (packed.ok) {
    rmSync(join(staging, ".."), { recursive: true, force: true });
    terminalStdout.result(
      code === 0,
      `[collect] ${code === 0 ? "证据包" : "失败 Evidence Bundle"}: ${delivery.path}\n`,
    );
  } else {
    terminalStderr.error(`[collect] 打包失败（${packed.stderr.trim().split("\n")[0]}），证据保留在目录: ${staging}\n`);
    return 1;
  }
  return code;
}

export async function collectLog(
  opts: LogCollectOptions,
  executor: Executor,
  log: (line: string) => void,
  linePattern: RegExp | undefined = buildLogPattern(opts.errorsOnly, opts.pattern),
): Promise<number> {
  const startedAt = new Date().toISOString();
  const bundle = new EvidenceBundle(opts.outputDir);
  const config: LogProbeConfig = { ...opts, linePattern };
  const ctx = {
    access: new KubectlPodLogAccess(executor, opts.namespace),
    bundle,
    log,
  };

  const facts = await runInspects<LogInspectionFacts>([
    makeLogInspect(ctx, opts.services),
  ], undefined, log);
  const observations = await runProbes(
    opts.services.map(makeServiceLogProbe),
    ctx,
    facts,
    config,
    log,
  );
  const rendered = renderLogResult(config, facts, observations);
  writeFileSync(join(opts.outputDir, "timeline.jsonl"), renderTimelineJsonl(rendered.timeline), "utf-8");
  writeFileSync(join(opts.outputDir, "service-logs.txt"), rendered.serviceLogs, "utf-8");
  bundle.writeSummary(rendered.summary);

  const kubectlVersion = facts.runtime.status === "collected"
    ? facts.runtime.kubectlVersion
    : undefined;
  bundle.writeManifest({
    doctorVersion: DOCTOR_CLI_VERSION,
    kubectlVersion,
    target: {
      namespace: opts.namespace,
      biz_id: opts.bizId ?? opts.traceId,
      trace_id: opts.traceId,
      services: opts.services,
    },
    inspectionFacts: facts,
    params: {
      since: opts.since,
      since_time: opts.sinceTime,
      errors_only: opts.errorsOnly,
      pattern: opts.pattern,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  if (facts.runtime.status !== "collected") return 1;
  if (facts.servicePods.status !== "collected") return 1;
  log(`[collect] 完成（扫描 ${rendered.stats.podCount} pod，命中 ${rendered.stats.matchedEventCount} 个日志事件，失败 ${rendered.stats.failedCount} pod）。`);
  const podEvidence = observations.flatMap((observation) => observation.pods.map((pod) => !pod.failed));
  return evaluateCollectOutcome(podEvidence).exitCode;
}
