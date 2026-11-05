import { describeOpenSearchError, type SearchEngine } from "@compforge/harness-toolbox/opensearch";
import type { KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { OpenSearchAuth } from "../../../infra/search/opensearch";
import { diagnosticMessage } from "../../../command/diagnostic";
import { currentCommandClients, currentCommandSignal } from "../../../command/execution-scope";
import { openOpenSearchAccess, OpenSearchAccessError, type OpenSearchConnectionPlan } from "../../../datasource/opensearch/access";
import type { StepInput } from "../../evidence";

export interface OpenSearchAccessPreparation {
  search?: SearchEngine;
  channel?: string;
  baseUrl?: string;
  evidenceTarget?: Record<string, unknown>;
  steps: StepInput[];
  failure?: { title: string; reason: string; diagnostics?: readonly string[] };
  close(): Promise<void>;
}

export interface OpenSearchAccessOptions {
  connection?: OpenSearchConnectionPlan;
  kube?: KubectlOptions;
  auth: OpenSearchAuth;
}

/** @spec Adapt data-source access diagnostics to Collect evidence; client and transport ownership stays in datasource. */
export async function prepareOpenSearchAccess(
  opts: OpenSearchAccessOptions,
  emit: (line: string, tone?: "info" | "warning") => void,
  injectedSearch?: SearchEngine,
): Promise<OpenSearchAccessPreparation> {
  const signal = currentCommandSignal();
  signal?.throwIfAborted();
  const diagnostics: string[] = [];
  const failureDiagnostics: string[] = [];
  const steps: StepInput[] = [];
  const log = (line: string, tone?: "info" | "warning") => {
    diagnostics.push(`${new Date().toISOString()} ${line}`);
    emit(line, tone);
  };
  const recordDiagnostics = (status: "ok" | "failed") => steps.push({
    id: "opensearch-access", title: "OpenSearch 访问诊断", risk: "observe", status,
    output: diagnostics.join("\n"), ext: "log",
  });
  const failed = (title: string, reason: string): OpenSearchAccessPreparation => {
    log(`[collect] ${title}：${reason}`, "warning");
    recordDiagnostics("failed");
    return { steps, failure: { title, reason, diagnostics: failureDiagnostics }, close: async () => {} };
  };
  const connection = opts.connection;
  if (!connection) return failed("OpenSearch 准备失败", "配置确认阶段未提供连接计划");
  // @spec Persist bounded original stack frames before preparation failures become summaries.
  // @why Callers already capture streamed lines; only additional failure evidence is forwarded.
  const recordFailure = (error: unknown) => {
    const lines: string[] = [];
    const secrets = [opts.auth.username ?? "", opts.auth.password ?? "",
      ...(connection.kind === "service" ? [] : [connection.username ?? "", connection.password ?? ""])];
    const seen = new Set<unknown>();
    let cause = error;
    for (let depth = 0; cause instanceof Error && !seen.has(cause) && depth < 4; depth++) {
      seen.add(cause);
      lines.push(`${new Date().toISOString()} [collect] OpenSearch connect cause=${depth} ${describeOpenSearchError(cause)}`);
      for (const frame of (cause.stack ?? "").split("\n").filter(line => /^\s+at /.test(line)).slice(0, 16)) {
        lines.push(diagnosticMessage(frame, secrets).slice(0, 1024));
      }
      cause = cause.cause;
    }
    diagnostics.push(...lines);
    failureDiagnostics.push(...lines);
  };
  let channel = connection.kind === "service"
    ? `port-forward svc/${connection.service.name}（${connection.service.namespace}）` : `直连 ${connection.endpoint}`;
  try {
    const access = await openOpenSearchAccess({ ...opts, connection, signal,
      clients: injectedSearch ? undefined : currentCommandClients(),
      onDiagnostic: line => log(`[collect] ${line}`),
      onRoute: route => {
        if (route.transport === "pod-relay") channel = `Pod relay（${opts.kube?.namespace ?? "default"}）`;
        steps.push({ id: "channel", title: "OpenSearch 连接", risk: "observe", status: "ok",
          output: `transport=${route.transport}${route.reason ? ` fallback_reason=${route.reason}` : ""}` });
        log(`[collect] OpenSearch 连接成功：${channel}${route.reason ? `（直连失败：${route.reason}）` : ""}`);
      },
    }, injectedSearch);
    recordDiagnostics("ok");
    return { ...access, channel, steps };
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof OpenSearchAccessError)) throw error;
    const reason = error.message;
    steps.push({ id: "channel", title: "OpenSearch 连接", risk: "observe", status: "failed", reason });
    recordFailure(error.cause);
    const preparation = failed("OpenSearch 连接失败", reason);
    for (const cleanup of error.cleanupErrors) {
      const reason = describeOpenSearchError(cleanup);
      steps.push({ id: "opensearch-cleanup", title: "OpenSearch 资源清理", risk: "observe", status: "failed", reason });
      preparation.failure!.reason += `; cleanup failed: ${reason}`;
    }
    return preparation;
  }
}
